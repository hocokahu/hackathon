# CLAUDE.md — Composable AI Hackathon 2026 (Okahu)

What this repo is: our entry for the hackathon's **Track T6** — an AI shopping agent that works
across four platforms (Bloomreach, Google/Gemini, Shopify, Databricks). Full details in
**README.md**. Strategy notes in **bloomreach_hackathon.md**.

## How to work in this repo (rules for the AI)

1. **Check, don't guess.** Before stating anything as fact, confirm it with the real thing —
   the API, an MCP tool, the CLI, or the browser. If you can't verify it, say so plainly. Never
   report a result you did not actually observe.
2. **Write for a busy human.** Be precise, short, and easy to read.
   - **Simple words, no jargon.** Explain things plainly. If you must use a technical term,
     say what it means in a few words the first time.
   - **Easy to scan.** Lead with the answer. Use short sentences, bullets, and small tables.
     Cut filler and repetition. Don't wall-of-text.
   - **Always end with "What you (the human) do next."** A short, numbered list of the exact
     steps the person should take — plain clicks/commands, in order. If nothing is needed from
     them, say "Nothing needed from you."
   - **Be honest and exact.** Say what actually happened, what worked, what didn't, and why.
     No vague claims.
3. **Never attribute commits to Claude.** Do not add a `Co-Authored-By: Claude` line — or any
   Claude/AI co-author or attribution — to git commits or pull requests.
4. **Protect other accounts on this machine** (see next section).

## ⛔ Other accounts may live on this machine — check before you act

This laptop may have **other Shopify accounts and stores**, and **other Google Cloud accounts and
projects**, that are NOT part of this hackathon. **Do not assume** which account, store, or project
you are pointed at — **always check first**. Only ever act on our hackathon resources; their
identifiers and credentials are in **`.env`**.

**Shopify**
- Our hackathon store, org, and account are in `.env` (`SHOPIFY_STORE_DOMAIN`, `SHOPIFY_PARTNER_EMAIL`, `SHOPIFY_PARTNER_ORG_ID`). Use only these.
- Other Shopify accounts or stores may be signed in here (in the browser or the CLI). Leave them alone. Before any store or CLI action, confirm you're pointed at our store/account.
- Never run `shopify auth logout` (it can sign out an account you don't own). Never `npm install -g @shopify/cli` (it changes a shared CLI) — always use `npx @shopify/cli@latest`. Our store was set up via the browser Dev Dashboard, not the CLI.

**Google Cloud**
- Our project id is in `.env` (`GCP_PROJECT_ID`). Only touch that project.
- Other Google Cloud accounts or projects may be signed in here. Leave them alone; check the active project before acting.

**Browser**
- Do console/browser work in the separate "hackathon" Chrome profile so it never mixes with the everyday browser:
  `source .hackathon-browser.env` then `~/.claude/skills/gstack/browse/dist/browse connect`.

## Secrets and config
- Real credentials live in **`.env`** (never committed). Safe template: **`.env.example`**.
- MCP secrets (e.g. the Databricks token) go in **`.claude/settings.local.json`** (never committed) and are referenced as `${NAME}` inside `.mcp.json`. Claude Code does not read `.env`, so secrets must live here or in the shell.
- Never commit: `.env`, `.claude/settings.local.json`, `.hackathon-browser.env` (all gitignored).

## MCP servers (listed in `.mcp.json`; approve once by restarting `claude`)
| Name | What it does | Sign-in |
|---|---|---|
| `loomi-connect` | Bloomreach: audiences, activation, product search | opens a Bloomreach login the first time |
| `shopify-dev` | Shopify docs + GraphQL schema + code checks | none |
| `shopify-storefront` | Answers about store policies/FAQ. (Catalog, cart, and checkout moved to Shopify's newer "UCP" endpoint `/api/ucp/mcp`, which needs a registered agent profile — for catalog use the Admin API + Loomi instead.) | none |
| `databricks-genie` | Ask plain-English questions about the data | Databricks token |
| `databricks-uc-functions` | Run saved Databricks functions | Databricks token |

Also installed: the **Shopify AI Toolkit** (skills named `shopify-plugin:*`).

## Platforms, one line each (full detail in README.md)
- **Databricks** — workspace `bloomreach-hackathon-workspace`; data in catalog `databricks-hackathon`, schema `00data`.
- **Google Cloud** — Qwiklabs student project (id in `.env`), region us-east1; 3 lab VMs; no storage/BigQuery/Cloud Run yet.
- **Bloomreach** — Engagement project `gentle-gyroscope`; Loomi Connect MCP.
- **Shopify** — our dev store (domain in `.env`; Shopify Plus, sample data). Storefront password in `.env`.
