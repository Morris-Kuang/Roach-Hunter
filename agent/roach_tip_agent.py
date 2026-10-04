"""
Roach Hunter tip-line agent -- MHacks 2026 "ASI:One Agent Challenge" (Fetch.ai) entry.

Registers on Agentverse via the Agent Chat Protocol (ACP), so a user can type
a sighting report straight into ASI:One's chat (e.g. "I just saw a roach
near the desk!") and have ASI:One route it here. This agent parses which
room landmark was mentioned and dispatches the actual Roach Hunter 3D
simulation to go investigate it -- the point isn't a chatbot reply, it's a
real action taken against a running (simulated) autonomous robot.

Architecture: this agent is a separate Python process from the browser-based
sim (../sim/), which only runs client-side JS with no backend of its own. So
this agent hands the parsed location off over plain HTTP to a tiny bridge
endpoint ../sim/serve_nocache.py exposes, and the sim's own JS polls that
endpoint and feeds it through the exact same reportSighting()/startPatrol()
pipeline the sim's own chat box already uses for manually-typed tips.

Run order:
  1. python3 ../sim/serve_nocache.py        (serves the sim + the bridge API)
  2. python3 roach_tip_agent.py             (this agent)
Then connect this agent's mailbox to Agentverse via its Inspector URL
(printed on startup) so ASI:One can route to it -- see README.md.
"""

import json
import os
import urllib.request

from openai import AsyncOpenAI
from uagents import Agent, Context, Model, Protocol
from uagents_core.contrib.protocols.chat import (
    ChatAcknowledgement,
    ChatMessage,
    EndSessionContent,
    StartSessionContent,
    TextContent,
    chat_protocol_spec,
)

# ---- bridge to the running sim (../sim/serve_nocache.py) ----
SIM_BRIDGE_URL = os.environ.get("SIM_BRIDGE_URL", "http://localhost:8000/api/report")

# ---- location keyword matching ----
# Kept in lockstep with sim/js/constants.js's REPORTABLE_LOCATIONS and
# sim/js/chat.js's parseLocation() -- same vocabulary, same coordinates, same
# "more specific terms before the generic ones they textually contain" order
# (e.g. the nightstand's "床頭櫃" must be checked before the bed's plain "床").
REPORTABLE_LOCATIONS = [
    {"name": "the nightstand", "zh": "床頭櫃", "keywords": ["床頭櫃", "床頭", "nightstand"], "x": -2.6, "z": -3.3},
    {"name": "the wardrobe", "zh": "衣櫃", "keywords": ["衣櫃", "衣柜", "衣櫥", "wardrobe", "closet"], "x": 4.7, "z": 1.4},
    {"name": "the desk", "zh": "書桌", "keywords": ["書桌", "電腦桌", "桌子", "桌邊", "desk", "table"], "x": 4.2, "z": -2.6},
    {"name": "the trash can", "zh": "垃圾桶", "keywords": ["垃圾桶", "垃圾筒", "trash", "garbage", "bin"], "x": 4.5, "z": 3.1},
    {"name": "the window", "zh": "窗戶", "keywords": ["窗戶", "窗邊", "窗台", "window"], "x": -2.0, "z": -3.2},
    {"name": "the bed", "zh": "床", "keywords": ["床邊", "床上", "床底", "棉被", "枕頭", "床", "bed"], "x": -3.0, "z": -1.5},
    {"name": "the sofa", "zh": "沙發", "keywords": ["沙發", "sofa", "couch"], "x": -4.9, "z": 2.3},
    {"name": "the left wall", "zh": "左邊牆壁", "keywords": ["左牆", "左邊牆", "左邊的牆", "left wall"], "x": -5.4, "z": 2.5},
    {"name": "the right wall", "zh": "右邊牆壁", "keywords": ["右牆", "右邊牆", "右邊的牆", "right wall"], "x": 5.4, "z": -2.0},
    {"name": "the back wall", "zh": "後面牆壁", "keywords": ["後牆", "後面牆", "後面的牆", "back wall"], "x": 0.5, "z": -3.6},
    {"name": "the front wall", "zh": "前面牆壁", "keywords": ["前牆", "前面牆", "前面的牆", "front wall"], "x": -2.5, "z": 3.6},
]


def parse_location(text: str):
    """Deterministic keyword fallback -- only understands this fixed vocabulary."""
    lower = text.lower()
    for loc in REPORTABLE_LOCATIONS:
        for kw in loc["keywords"]:
            if kw.lower() in lower:
                return loc
    return None


# ---- real NLU via ASI:One's own LLM (the Fetch.ai ecosystem's model -- the
# fitting choice for *their* challenge, rather than reaching for a competitor's
# API) ----
ASI_ONE_API_KEY = os.environ.get("ASI_ONE_API_KEY")
LOCATION_NAMES = [loc["name"] for loc in REPORTABLE_LOCATIONS]

_SYSTEM_PROMPT = (
    "You are the intent classifier for a cockroach-hunting robot's tip line. "
    "The room has exactly these landmarks: " + ", ".join(LOCATION_NAMES) + ". "
    "The user's message may be in Chinese or English, and may describe a "
    "location indirectly (e.g. 'where I keep my clothes' means the wardrobe). "
    "Decide which ONE landmark, if any, they are reporting a cockroach "
    "sighting near. Reply with ONLY the exact landmark name from the list "
    "above, verbatim -- or reply with exactly 'none' if the message doesn't "
    "describe a location in this room, or isn't a sighting report at all. "
    "No punctuation, no explanation, just the landmark name or 'none'."
)


# ASI:One is OpenAI-compatible, so the official SDK works against it by just
# pointing base_url at ASI:One instead of OpenAI. AsyncOpenAI (not the sync
# client) so this is a real await, no thread-pool workaround needed.
_asi_client = AsyncOpenAI(base_url="https://api.asi1.ai/v1", api_key=ASI_ONE_API_KEY) if ASI_ONE_API_KEY else None


async def _call_asi_one(text: str) -> str | None:
    try:
        response = await _asi_client.chat.completions.create(
            model="asi1-mini",  # fast/cheap -- this is a one-shot classification, not deep reasoning
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": text},
            ],
            max_tokens=16,
            temperature=0,
        )
        return response.choices[0].message.content
    except Exception:
        return None


def _normalize_name(s: str) -> str:
    s = s.strip().strip(".\"'").lower()
    return s[4:] if s.startswith("the ") else s  # the model doesn't always echo "the " back


async def understand_location(ctx: Context, text: str):
    """Try ASI:One's LLM for real NLU; fall back to keyword matching if no API
    key is configured or the call fails, so the agent still works either way."""
    if ASI_ONE_API_KEY:
        raw = await _call_asi_one(text)
        if raw is not None:
            answer = _normalize_name(raw)
            for loc in REPORTABLE_LOCATIONS:
                if _normalize_name(loc["name"]) == answer:
                    ctx.logger.info(f"ASI:One understood '{text}' -> {loc['name']}")
                    return loc
            if answer == "none":
                ctx.logger.info(f"ASI:One understood '{text}' -> no location mentioned")
                return None
            ctx.logger.info(f"ASI:One returned unrecognized answer {raw!r}, falling back to keywords")
        else:
            ctx.logger.info("ASI:One call failed, falling back to keyword matching")
    return parse_location(text)


def dispatch_to_sim(loc: dict) -> bool:
    """POST the parsed location to the running sim's bridge endpoint. Returns True on success."""
    payload = json.dumps({"x": loc["x"], "z": loc["z"], "name": loc["name"], "zh": loc["zh"]}).encode()
    req = urllib.request.Request(SIM_BRIDGE_URL, data=payload, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


SEED_PHRASE = os.environ.get("AGENT_SEED")
if not SEED_PHRASE:
    raise SystemExit(
        "Set AGENT_SEED to a secret phrase before running (determines this agent's "
        "fixed address) -- e.g.: AGENT_SEED='pick-something-random' python3 roach_tip_agent.py"
    )

agent = Agent(
    name="roach-hunter-tip-agent",
    seed=SEED_PHRASE,
    port=8001,  # NOT 8000 -- that's the sim's own dev server
    mailbox=True,
    network="testnet",  # avoids needing real FET funds for Almanac contract registration
    publish_agent_details=True,
    readme_path="README.md",
    description=(
        "Reports a cockroach sighting (in Chinese or English, naming a room landmark -- "
        "bed, nightstand, wardrobe, desk, trash can, or window) to the Roach Hunter "
        "autonomous pest-control robot, which drives to that spot and stakes it out."
    ),
)

chat_proto = Protocol(spec=chat_protocol_spec)


def create_text_chat(text: str) -> ChatMessage:
    return ChatMessage(content=[TextContent(text=text), EndSessionContent()])


async def process_tip_via_bridge(ctx: Context, text: str) -> str:
    """Understand a sighting report and dispatch it to the sim over the
    /api/report bridge. Used by the ACP handler (ASI:One / other agents),
    which have no synchronous channel back to a specific browser tab -- the
    bridge + the sim's own polling is the only way to reach it."""
    loc = await understand_location(ctx, text)
    if loc is None:
        return "我聽不太懂是哪個位置，可以提到：床、床頭櫃、衣櫃、書桌、垃圾桶、或窗戶嗎？"
    if dispatch_to_sim(loc):
        return f"收到！已經派機器人去{loc['zh']}附近蹲點了。"
    return (
        f"我解析出地點是{loc['zh']}，但連不上正在跑的模擬器。"
        "確認 sim/serve_nocache.py 有在跑，而且瀏覽器頁面是開著的嗎？"
    )


@chat_proto.on_message(ChatMessage)
async def handle_message(ctx: Context, sender: str, msg: ChatMessage):
    # Always acknowledge receipt first, per the ACP spec.
    await ctx.send(sender, ChatAcknowledgement(acknowledged_msg_id=msg.msg_id))

    for item in msg.content:
        if isinstance(item, StartSessionContent):
            ctx.logger.info(f"Session started with {sender}")

        elif isinstance(item, TextContent):
            ctx.logger.info(f"Tip from {sender}: {item.text}")
            reply = await process_tip_via_bridge(ctx, item.text)
            await ctx.send(sender, create_text_chat(reply))

        elif isinstance(item, EndSessionContent):
            ctx.logger.info(f"Session ended with {sender}")


@chat_proto.on_message(ChatAcknowledgement)
async def handle_acknowledgement(ctx: Context, sender: str, msg: ChatAcknowledgement):
    ctx.logger.info(f"Received acknowledgement from {sender} for message {msg.acknowledged_msg_id}")


agent.include(chat_proto, publish_manifest=True)


# ---- direct REST endpoint for the sim's own chat box ----
# The ACP path above is for ASI:One / other agents, which have no synchronous
# channel back to a specific browser tab, so they go through the
# /api/report bridge + the sim's own polling. Our own sim UI is local to
# this machine and *does* get a direct synchronous reply, so it skips the
# bridge entirely: this returns the parsed (x, z) directly and lets the
# browser dispatch it itself, instead of also pushing through the bridge
# (which would make the sim's poll loop dispatch it a second time).
class ChatRequest(Model):
    text: str


class ChatResponse(Model):
    reply: str
    x: float | None = None
    z: float | None = None
    name: str | None = None
    zh: str | None = None


@agent.on_rest_post("/chat", ChatRequest, ChatResponse)
async def handle_rest_chat(ctx: Context, req: ChatRequest) -> ChatResponse:
    ctx.logger.info(f"Tip via local REST: {req.text}")
    loc = await understand_location(ctx, req.text)
    if loc is None:
        return ChatResponse(reply="我聽不太懂是哪個位置，可以提到：床、床頭櫃、衣櫃、書桌、垃圾桶、或窗戶嗎？")
    return ChatResponse(
        reply=f"收到！已經派機器人去{loc['zh']}附近蹲點了。",
        x=loc["x"], z=loc["z"], name=loc["name"], zh=loc["zh"],
    )


class LossEventRequest(Model):
    target_id: int
    location_name: str
    location_zh: str
    sim_time: str
    roach_behavior: str | None = None  # 'foraging' | 'fleeing' | 'retreating' | ...
    flee_target: str | None = None     # hideout name, only set if roach_behavior == 'fleeing'


class LossEventResponse(Model):
    description: str


_LOSS_FALLBACK_TEMPLATES = {
    "fleeing": "牠似乎是被嚇到，加速逃向{flee}，一下子就不見蹤影。",
    "foraging": "牠原本只是悠哉地四處覓食，一轉眼就消失在視線外。",
    "retreating": "牠好像自己準備收工回家，不急不徐地走出了鏡頭範圍。",
}


def _fallback_loss_description(req: "LossEventRequest") -> str:
    template = _LOSS_FALLBACK_TEMPLATES.get(req.roach_behavior, "牠在鏡頭前晃了一下，就不見了。")
    return template.format(flee=req.flee_target or "某個角落")


@agent.on_rest_post("/describe_loss", LossEventRequest, LossEventResponse)
async def handle_describe_loss(ctx: Context, req: LossEventRequest) -> LossEventResponse:
    """Narrate the moment a tracked roach was lost. ASI:One's models don't
    document vision/image support, so this is grounded in the sim's actual
    structured facts (position, the roach's real behavior state, its flee
    target) rather than guessing from pixels -- the LLM adds vivid, plausible
    sensory color on top of facts we already know to be true, not invented
    ones. The sim still shows the user the real captured frame alongside
    this text; this only generates the narration."""
    if not ASI_ONE_API_KEY:
        return LossEventResponse(description=_fallback_loss_description(req))

    facts = (
        f"Location when lost: near {req.location_zh} ({req.location_name}). "
        f"Its behavior at the time: {req.roach_behavior or 'unknown'}."
        + (f" It was fleeing toward {req.flee_target}." if req.flee_target else "")
    )
    prompt = (
        "You are narrating a brief, vivid incident note for a home pest-control "
        "robot's owner, in Traditional Chinese (繁體中文), about the exact moment "
        "it just lost visual track of a cockroach it was chasing. Refer to it "
        "only as 蟑螂 or 牠 (whichever reads naturally) -- never an ID "
        "number or '#', the owner doesn't track individual roaches by number. "
        "Stay grounded in these facts -- do not invent anything that "
        "contradicts them, but you may add plausible sensory color (lighting, "
        "a flicker of movement, the scuffle of tiny legs, a shadow under "
        "furniture, etc.): " + facts +
        " Write exactly ONE short sentence in Traditional Chinese, at most about "
        "40 characters, no quotation marks, no explanation -- just the sentence."
    )
    try:
        response = await _asi_client.chat.completions.create(
            model="asi1-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=100,
            temperature=0.8,
        )
        text = (response.choices[0].message.content or "").strip().strip("\"'「」")
        if not text:
            raise ValueError("empty response")
        return LossEventResponse(description=text)
    except Exception:
        ctx.logger.info("describe_loss: ASI:One call failed, using fallback description")
        return LossEventResponse(description=_fallback_loss_description(req))


class CaptureEventRequest(Model):
    location_name: str
    location_zh: str
    sim_time: str
    success: bool
    was_fleeing: bool


class CaptureEventResponse(Model):
    description: str


_CAPTURE_FALLBACK_TEMPLATES = {
    (True, True): "即使拼命逃竄，還是被一把按住，處理乾淨了。",
    (True, False): "伸手一抓，牠完全來不及反應，當場解決。",
    (False, True): "牠跑得太快，手腳再快還是慢了一步，還是讓牠溜了。",
    (False, False): "眼看就要到手，牠卻靈巧一閃，還是逃掉了。",
}


def _fallback_capture_description(req: "CaptureEventRequest") -> str:
    return _CAPTURE_FALLBACK_TEMPLATES[(req.success, req.was_fleeing)]


@agent.on_rest_post("/describe_capture", CaptureEventRequest, CaptureEventResponse)
async def handle_describe_capture(ctx: Context, req: CaptureEventRequest) -> CaptureEventResponse:
    """Narrate a capture attempt's outcome, same grounded-facts approach as
    describe_loss: real sim facts in, LLM adds vivid color, never invents
    anything that contradicts the actual outcome."""
    if not ASI_ONE_API_KEY:
        return CaptureEventResponse(description=_fallback_capture_description(req))

    facts = (
        f"Location: near {req.location_zh} ({req.location_name}). "
        f"Outcome: {'a successful capture' if req.success else 'a failed capture attempt -- the target got away'}. "
        f"The target was {'actively fleeing/panicked' if req.was_fleeing else 'calm, unaware it was about to be grabbed'} "
        "at the moment of the attempt."
    )
    prompt = (
        "You are narrating a brief, vivid incident note for a home pest-control "
        "robot's owner, in Traditional Chinese (繁體中文), about the exact moment "
        "it just attempted to capture a cockroach it was chasing. Refer to it "
        "only as 蟑螂 or 牠 (whichever reads naturally) -- never an ID number. "
        "Stay grounded in these facts -- do not invent anything that contradicts "
        "them (especially the outcome: success must sound like success, a miss "
        "must sound like a miss), but you may add plausible sensory/physical "
        "color (the snap of the gripper, a desperate final dash, stillness "
        "after, etc.): " + facts +
        " Write exactly ONE short sentence in Traditional Chinese, at most about "
        "40 characters, no quotation marks, no explanation -- just the sentence."
    )
    try:
        response = await _asi_client.chat.completions.create(
            model="asi1-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=100,
            temperature=0.8,
        )
        text = (response.choices[0].message.content or "").strip().strip("\"'「」")
        if not text:
            raise ValueError("empty response")
        return CaptureEventResponse(description=text)
    except Exception:
        ctx.logger.info("describe_capture: ASI:One call failed, using fallback description")
        return CaptureEventResponse(description=_fallback_capture_description(req))


class HealthResponse(Model):
    ok: bool


@agent.on_rest_get("/health", HealthResponse)
async def handle_health(ctx: Context) -> HealthResponse:
    """Plain liveness check for the sim's UI badge -- no business logic, just
    proves the process is up, so the badge doesn't rely on reading a 404."""
    return HealthResponse(ok=True)

if __name__ == "__main__":
    agent.run()
