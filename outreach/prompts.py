"""Prompts for drafting outreach and answering replies."""
import json

DRAFT_SYSTEM = """You write a short first email from an investor to a startup founder.

Rules:
- Under 120 words in the body.
- Mention one specific, real detail from the evidence so the email is clearly personal.
  OPENERS are suggestions written by another AI and are not verified. Use one only for its angle,
  and only repeat a fact, name or number from it if that same fact also appears in "why" or "quote".
  When in doubt, build the line from the quote.
- Say plainly why this investor is interested, tied to their thesis, in your own words.
  Never paste the thesis text: reuse at most three words in a row from it.
- One clear ask: a 20-minute call.
- Use only facts given to you. Never invent traction, customers, numbers or mutual connections.
- No flattery and no buzzwords.
- If founder_name is empty, open with "Hi <company> team".
- Sign off with the investor's name and firm.

Return only JSON: {"subject": "...", "body": "..."}"""


REPLY_SYSTEM = """You write the investor's answer to a founder's reply to an outreach email.

First decide the founder's intent:
- "interested": they want to talk. Propose 2 or 3 times, copied exactly from AVAILABLE TIMES.
- "declined": they said no. Thank them in one or two sentences. Propose no times.
- "unclear": ask one short clarifying question. Propose no times.

Rules: under 90 words, warm and direct, no invented facts, sign off with the investor's name.

Return only JSON: {"intent": "interested|declined|unclear", "response_body": "...", "proposed_times": ["..."]}"""


def draft_user(record, investor):
    return (
        f"INVESTOR: {investor['name']}, {investor['firm']}\n"
        f"INVESTOR THESIS:\n{record.get('thesis', '').strip()}\n\n"
        "FOUNDER EVIDENCE:\n"
        # The website is left out on purpose: many are guessed from the company name, and a wrong
        # one would put another company's details into the email. quote_url is the verified page.
        + json.dumps({k: record.get(k, "") for k in
                      ("founder_name", "company", "why", "quote", "quote_url")},
                     indent=2)
        + ("\n\nOPENERS:\n" + "\n".join(f"- {o}" for o in record["openers"])
           if record.get("openers") else "")
    )


def reply_user(draft, reply_text, slots, investor):
    return (
        f"INVESTOR: {investor['name']}, {investor['firm']}\n"
        f"FOUNDER: {draft['record'].get('founder_name') or draft['record']['company'] + ' team'}\n\n"
        f"OUR EMAIL:\nSubject: {draft['subject']}\n{draft['body']}\n\n"
        f"FOUNDER'S REPLY:\n{reply_text}\n\n"
        "AVAILABLE TIMES:\n" + "\n".join(f"- {s}" for s in slots)
    )
