# SHIPPROOF ENGINEER — workspace guide

Open it with the **Engineer** button (header, or the bottom bar on phones), with Ctrl/⌘K → "SHIPPROOF ENGINEER", or with **Ask the engineer** on a repair task (Failure analysis) or **Ask the engineer about this** on an incident.

- **Typed conversation.** Enter sends, Shift+Enter adds a line, Stop work interrupts, End conversation closes it after confirmation.
- **Context.** "Ask the engineer" attaches the record's fields as a labelled block. Nothing is sent until you type a question, and you can remove the attachment.
- **Permissions.** Read-only is the default. Engineering autonomy is offered only if your account has it; the server enforces this on every request. Production actions appear as approvals and can only be decided by an approver, never by voice.
- **Evidence.** `E-n` references in the transcript and tool activity open the exact evidence record for that conversation.
- **Project.** The conversation stays bound to the project it started on. Starting one for another project asks first.
- **Voice.** Not in the drawer. Use the On-call screen (Connect voice). Typing always works without voice credentials.
- **Reconnect.** If the connection drops, the drawer reconnects and replays missed events; duplicates are ignored.

Limits: the drawer only shows what the server returns; it does not stream tokens (the reasoning provider returns complete messages).
