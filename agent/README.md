# Roach Hunter Tip-Line Agent

A [uAgents](https://github.com/fetchai/uAgents) agent for the MHacks 2026
**ASI:One Agent Challenge** (Fetch.ai). It implements the Agent Chat Protocol
(ACP) so it's discoverable and directly chattable through
[ASI:One](https://asi1.ai/) once registered on
[Agentverse](https://agentverse.ai/).

## What it does

This is the tip line for **Roach Hunter**, an autonomous pest-control robot
(see the repo root). Tell it where you saw a cockroach -- in Chinese or
English, naming a landmark in the room (or describing it indirectly, e.g.
"where I keep my clothes") -- and it dispatches the robot to go investigate:

> **You:** 蟑螂剛剛在床邊出現，我有看到！
> **Agent:** 收到！已經派機器人去床附近蹲點了。

> **You:** I just saw one near the desk!
> **Agent:** 收到！已經派機器人去書桌附近蹲點了。

This isn't a reply-only chatbot: the agent parses the landmark, and calls out
over HTTP to the running [Roach Hunter 3D sim](../sim/), which drives its
simulated robot to that spot and holds a stakeout there (see
`reportSighting()` / `STAKEOUT` in `../sim/js/controller.js`) -- a real state
change in a running autonomous system, not just a text response.

Recognized landmarks: 床 (bed), 床頭櫃 (nightstand), 衣櫃 (wardrobe), 書桌
(desk), 垃圾桶 (trash can), 窗戶 (window).

**Understanding the message:** if `ASI_ONE_API_KEY` is set, the agent asks
ASI:One's own `asi1-mini` model to classify the message against that
landmark list -- real NLU, not just string matching, so paraphrases and
indirect descriptions work too. Without a key (or if the call fails for any
reason), it falls back to plain keyword matching, so the agent always works
even before you've set one up.

## Running it

1. Start the sim's dev server first (it also hosts the bridge API this agent calls):
   ```bash
   cd ../sim && python3 serve_nocache.py
   ```
   Open `http://localhost:8000` in a browser and leave it open.

2. In a second terminal, run this agent:
   ```bash
   cd agent
   source .venv/bin/activate   # created with: python3 -m venv .venv && pip install -r requirements.txt
   AGENT_SEED='pick-your-own-secret-phrase' \
   ASI_ONE_API_KEY='sk-...'    \
   python3 roach_tip_agent.py
   ```
   `ASI_ONE_API_KEY` is optional but recommended -- get one free from the
   [ASI:One platform](https://asi1.ai/)'s Developer section (Create New ->
   name it -> save the key). Without it, location matching falls back to
   plain keywords instead of real LLM understanding.

3. The startup log prints a **Local Agent Inspector** URL. Open it, click
   **Connect → Mailbox**, and follow the prompts (requires an Agentverse
   account) to link this agent's mailbox to Agentverse. Once connected and
   the chat protocol manifest is published, the agent becomes visible to
   ASI:One -- open its Agent Profile from the Inspector and click
   **Chat with Agent** to talk to it through ASI:One directly.

## Architecture note

The sim is a static, client-side-only Three.js page with no backend, and
this agent is a separate Python process -- they can't call each other's
functions directly. `../sim/serve_nocache.py` bridges the two with a tiny
JSON API:

- `POST /api/report` -- this agent calls it with `{x, z, name, zh}` once it
  parses a landmark out of your message.
- `GET /api/poll` -- the sim's own JS (`../sim/js/main.js`) polls this every
  ~1.5s; a pending report is fed through the same `reportSighting()` /
  `startPatrol()` path the sim's built-in chat box already uses for
  manually-typed tips, and consumed (cleared) once read.
