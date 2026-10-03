"""
Online test-time adaptation (TTA) for the roach detector, implementing the
EATA mechanism (Niu et al., 2022, "Efficient Test-Time Model Adaptation
without Forgetting" -- mhacks.v1i.yolov8/adaptive_computation_paper/ETA.pdf)
as faithfully as a single-class detector allows, on top of TENT's (Wang et
al., 2021) entropy-minimization/BN-affine-only adaptation.

MEMO and TTT (the other two papers in that folder) are deliberately not
used: MEMO needs several augmented forward+backward passes per single
frame (too slow for a real-time chase loop), and TTT needs a
rotation-prediction head baked in at training time (would require
retraining from scratch to add it). TENT+EATA give the "adapt from an
unlabeled test stream" idea at a cost that fits one webcam frame.

What's implemented, mapped to the EATA paper's equations:

  E(x;Theta)   mean Bernoulli entropy of the top-k highest-confidence
               anchors (single-class, so each anchor's class score is a
               Bernoulli probability, not a softmax -- this is the
               detection analogue of the classification entropy in Eq.2).
  S^ent(x)     Eq.3: exp(E0 - E(x)) if E(x) < E0 else 0. Downweights/
               excludes samples whose prediction is too uncertain to
               trust for a gradient step.
  S^div(x)     Eq.5: 1 if cos(cls_vector, m_prev) < eps else 0, where
               cls_vector is the full per-anchor confidence vector (the
               detection analogue of the per-class probability vector
               the paper compares) and m_prev is an EMA (Eq.4) of recent
               frames' cls_vectors. Excludes frames that look like ones
               we already adapted on.
  S(x)         Eq.6: S^ent(x) * S^div(x). Zero => skip backward entirely.
  R(.)         Eq.7: Fisher-weighted L2 pull of BN affine params back to
               their post-training values ("anti-forgetting").
  omega(theta) Eq.9: Fisher importance. The paper estimates this from
               *unlabeled* test samples with pseudo-labels because they
               assume no access to labeled training data. We're not in
               that bind -- we still have the labeled train/val images
               this model was fine-tuned on -- so estimate_fisher() uses
               real labels and the real detection loss instead, which is
               strictly more accurate than the paper's own workaround.
  Eq.8         final objective: S(x)*E(x;Theta) + beta * R(.)
"""

import glob
import os

import cv2
import numpy as np
import torch
import torch.nn as nn

from ultralytics.data.utils import check_det_dataset
from ultralytics.utils import DEFAULT_CFG


def _letterbox_square(img_bgr: np.ndarray, imgsz: int) -> np.ndarray:
    # Dataset images are already square (Roboflow exported them stretched to
    # 512x512), so a plain resize introduces no padding/aspect distortion
    # beyond what's already baked into the stored files.
    return cv2.resize(img_bgr, (imgsz, imgsz), interpolation=cv2.INTER_LINEAR)


def _load_yolo_label(path: str) -> tuple[np.ndarray, np.ndarray]:
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        return np.zeros((0,), dtype=np.float32), np.zeros((0, 4), dtype=np.float32)
    rows = np.loadtxt(path, ndmin=2, dtype=np.float32)
    return rows[:, 0], rows[:, 1:5]


class EntropyTTA:
    def __init__(
        self,
        net: nn.Module,
        data_yaml: str | None = None,
        fisher_split: str = "val",
        fisher_images: int = 40,
        lr: float = 1e-3,
        beta: float = 1.0,
        entropy_margin: float = 0.4,   # E0 in nats; Bernoulli entropy maxes out at ln(2) = 0.693
        cos_sim_eps: float = 0.9,      # eps in Eq.5: below this cosine sim => "different enough", keep
        ema_alpha: float = 0.1,        # alpha in Eq.4
        top_k: int = 5,
        imgsz: int = 640,
    ):
        self.net = net
        self.device = next(net.parameters()).device
        self.beta = beta
        self.entropy_margin = entropy_margin
        self.cos_sim_eps = cos_sim_eps
        self.ema_alpha = ema_alpha
        self.top_k = top_k
        self.imgsz = imgsz

        self.bn_modules: dict[str, nn.BatchNorm2d] = {}
        self.anchors: dict[str, tuple[torch.Tensor, torch.Tensor]] = {}
        for name, m in self.net.named_modules():
            if isinstance(m, nn.BatchNorm2d):
                self.bn_modules[name] = m
                self.anchors[name] = (m.weight.detach().clone(), m.bias.detach().clone())

        if data_yaml is not None:
            self.fisher = self._estimate_fisher(data_yaml, fisher_split, fisher_images)
        else:
            self.fisher = {
                name: (torch.ones_like(m.weight), torch.ones_like(m.bias))
                for name, m in self.bn_modules.items()
            }

        self._enter_online_mode()
        trainable = [p for m in self.bn_modules.values() for p in (m.weight, m.bias)]
        self.optimizer = torch.optim.SGD(trainable, lr=lr, momentum=0.9)

        self.m_prev: torch.Tensor | None = None  # EMA of per-anchor confidence vectors (Eq.4)
        self.steps = 0
        self.skipped_uncertain = 0   # S^ent(x) == 0
        self.skipped_redundant = 0   # S^div(x) == 0

    # ------------------------------------------------------------------
    # Fisher importance (Eq.9, using real labels instead of pseudo-labels)
    # ------------------------------------------------------------------
    def _estimate_fisher(self, data_yaml: str, split: str, n_images: int):
        # check_det_dataset resolves train/val/test the same way ultralytics'
        # own trainer does (Roboflow's exported yaml uses "../x/images" paths
        # relative to a root that is NOT simply the yaml's own directory, so
        # a naive os.path.join would get this wrong).
        cfg = check_det_dataset(data_yaml)
        img_dir = cfg[split]
        label_dir = img_dir.replace("images", "labels")

        img_paths = sorted(glob.glob(os.path.join(img_dir, "*")))[:n_images]
        if not img_paths:
            raise FileNotFoundError(f"No images found under {img_dir}")

        was_training = self.net.training
        self.net.train()
        for p in self.net.parameters():
            p.requires_grad_(True)

        # A checkpoint loaded via YOLO(weights) stores net.args as a plain
        # dict of just the overrides used at train time (no box/cls/dfl loss
        # gains) -- v8DetectionLoss expects an attribute-access namespace
        # with those gains. Default gains are fine here: Fisher only needs
        # sensible relative loss-term weighting, not exact training fidelity.
        if isinstance(self.net.args, dict):
            self.net.args = DEFAULT_CFG

        fisher_acc = {
            name: (torch.zeros_like(m.weight), torch.zeros_like(m.bias))
            for name, m in self.bn_modules.items()
        }

        n_used = 0
        for img_path in img_paths:
            stem = os.path.splitext(os.path.basename(img_path))[0]
            label_path = os.path.join(label_dir, stem + ".txt")
            cls, boxes = _load_yolo_label(label_path)
            if len(cls) == 0:
                continue  # background-only image: no supervised signal for Fisher here

            frame = cv2.imread(img_path)
            resized = _letterbox_square(frame, self.imgsz)
            img = resized[:, :, ::-1].transpose(2, 0, 1)
            img = np.ascontiguousarray(img, dtype=np.float32) / 255.0
            img_tensor = torch.from_numpy(img).unsqueeze(0).to(self.device)

            batch = {
                "img": img_tensor,
                "cls": torch.from_numpy(cls).view(-1, 1).to(self.device),
                "bboxes": torch.from_numpy(boxes).to(self.device),
                "batch_idx": torch.zeros(len(cls), device=self.device),
            }

            preds = self.net(img_tensor)
            loss, _ = self.net.loss(batch, preds=preds)
            loss = loss.sum()

            self.net.zero_grad(set_to_none=True)
            loss.backward()

            with torch.no_grad():
                for name, m in self.bn_modules.items():
                    fw, fb = fisher_acc[name]
                    if m.weight.grad is not None:
                        fw += m.weight.grad.detach() ** 2
                    if m.bias.grad is not None:
                        fb += m.bias.grad.detach() ** 2
            n_used += 1

        self.net.zero_grad(set_to_none=True)
        if hasattr(self.net, "criterion"):
            del self.net.criterion  # drop the training-mode criterion state before going back online
        self.net.train(was_training)

        if n_used == 0:
            raise RuntimeError(f"No labeled (non-background) images found under {img_dir} for Fisher estimation")

        return {name: (fw / n_used, fb / n_used) for name, (fw, fb) in fisher_acc.items()}

    # ------------------------------------------------------------------
    # Online adaptation
    # ------------------------------------------------------------------
    def _enter_online_mode(self):
        self.net.eval()
        for p in self.net.parameters():
            p.requires_grad_(False)
        for m in self.bn_modules.values():
            m.train()  # use batch (current-frame) statistics instead of frozen running stats
            m.weight.requires_grad_(True)
            m.bias.requires_grad_(True)

    def reset(self):
        with torch.no_grad():
            for name, m in self.bn_modules.items():
                w0, b0 = self.anchors[name]
                m.weight.copy_(w0)
                m.bias.copy_(b0)
        self.m_prev = None
        self.steps = 0
        self.skipped_uncertain = 0
        self.skipped_redundant = 0

    def _reg_loss(self):
        loss = 0.0
        for name, m in self.bn_modules.items():
            w0, b0 = self.anchors[name]
            fw, fb = self.fisher[name]
            loss = loss + (fw * (m.weight - w0) ** 2).sum() + (fb * (m.bias - b0) ** 2).sum()
        return loss

    def step(self, img_tensor: torch.Tensor) -> tuple[bool, float, torch.Tensor]:
        """
        One TTA step on a single preprocessed frame tensor (1,3,H,W).

        Returns (adapted, confidence, y_detached):
        - `adapted`: True iff S(x) > 0 and a gradient step was taken.
        - `confidence`: mean top-k anchor confidence, for the on-screen HUD.
        - `y_detached`: this call's forward output (1,4+nc,A), detached --
          reuse it for NMS/drawing instead of running the network again.
        """
        with torch.enable_grad():
            y, _ = self.net(img_tensor)        # (1, 4+nc, A); class scores already sigmoid-ed
            cls_vec = y[:, 4, :]                 # nc == 1 -> (1, A) confidence per anchor
            y_detached = y.detach()

            k = min(self.top_k, cls_vec.shape[1])
            topk = torch.topk(cls_vec, k=k, dim=1).values
            conf = float(topk.mean().item())

            # --- Eq.5: non-redundant sample criterion ---
            cls_vec_detached = cls_vec.detach()
            if self.m_prev is None:
                s_div = 1.0  # first frame: nothing to be redundant against
            else:
                cos_sim = torch.nn.functional.cosine_similarity(cls_vec_detached, self.m_prev, dim=1).item()
                s_div = 1.0 if cos_sim < self.cos_sim_eps else 0.0

            # Eq.4: update moving average every frame (batch size 1 -> y_bar_t == cls_vec)
            self.m_prev = cls_vec_detached if self.m_prev is None else (
                self.ema_alpha * cls_vec_detached + (1 - self.ema_alpha) * self.m_prev
            )

            if s_div == 0.0:
                self.skipped_redundant += 1
                return False, conf, y_detached

            # --- Eq.3: reliable sample criterion ---
            p = topk.clamp(1e-6, 1 - 1e-6)
            entropy = -(p * torch.log(p) + (1 - p) * torch.log(1 - p))
            entropy_mean = entropy.mean()                       # E(x;Theta), differentiable
            entropy_val = float(entropy_mean.detach().item())
            if entropy_val >= self.entropy_margin:
                self.skipped_uncertain += 1
                return False, conf, y_detached
            s_ent = float(torch.exp(torch.tensor(self.entropy_margin - entropy_val)).item())  # Eq.3, no grad

            # --- Eq.8: S(x)*E(x;Theta) + beta*R ---
            loss = s_ent * entropy_mean + self.beta * self._reg_loss()

            self.optimizer.zero_grad()
            loss.backward()
            self.optimizer.step()
            self.steps += 1
            return True, conf, y_detached
