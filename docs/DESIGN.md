# Interface design plan

Status: **draft for approval**. No UI is built until this is approved.

## Subject, audience, job

- **Who uses it:** counter staff at small shops and clinics in India and the Gulf. They work in the inbox all day, often while serving people in person.
- **The screen's one job:** show at a glance who is holding each conversation, the assistant or a person, and make changing that one keystroke.
- **Where the look comes from:** what already sits on these counters:
  - the khata ledger with its ruled margin;
  - the rubber stamp and ink pad;
  - the duplicate order book with its yellow carbon copy;
  - the itemised thermal receipt;
  - the queue-token number.

The two demo tenants are fictional: **Qamar Phone Corner** (Karama, Dubai: English, Arabic, Hindi, Hinglish, Malayalam) and **Kayal Bakes** (Kochi: Malayalam, English, Hindi).

## 1. Palette

**Rule: colour means custody.** The chrome is ink on paper. The only colours on screen say who holds a conversation, plus the carbon-copy yellow that marks internal notes. There is no brand colour.

| Name        | Hex       | Job                                                                      | Contrast on Thermal / on white |
| ----------- | --------- | ------------------------------------------------------------------------ | ------------------------------ |
| Thermal     | `#F3F5F4` | Page background: cool receipt paper, deliberately not cream              | n/a                            |
| Ink         | `#18202E` | All text, links (underlined), focus rings, rules at low opacity          | 14.9 / 16.3                    |
| Graphite    | `#5B6573` | **The assistant holds it.** Pencil: provisional. Also secondary text     | 5.4 / 5.9                      |
| Ballpoint   | `#1F45B5` | **A person holds it.** The blue office pen: committed, signed            | 7.4 / 8.1                      |
| Stamp       | `#C21F32` | **Waiting for a person**, errors, window closed: "a person must act now" | 5.4 / 5.9                      |
| Carbon copy | `#FBEFB4` | Internal notes: the yellow duplicate that never leaves the shop          | Ink on it: 14.1                |

Derived neutrals:

- Sheet `#FFFFFF`: the thread pane, the page you write on.
- Rule soft `#D5DADE`: decorative dividers.
- Rule strong `#7D8693`: input and button borders, 3.4:1, which meets the 3:1 minimum for UI components.

White text on Ballpoint, Stamp and Graphite buttons is 8.1, 5.9 and 5.9.

Consequences of the rule:

- **Buttons take the colour of the holder they produce.** "Take over" is Ballpoint; "Hand back to assistant" is Graphite.
- **Sender labels** in a thread use the same colours: Assistant in Graphite, staff in Ballpoint, the customer in Ink.
- **Confirmations are not green.** "Sent" is plain Ink text. Delivery status is mono text (`sent 14:29 · delivered 14:29 · read 14:30`), never double ticks.
- **Colour never carries meaning alone.** Every custody colour also has a pattern (thin rule, hatch or solid) and a text stamp.

## 2. Type

All faces are OFL and self-hosted as `woff2` subsets: no font CDN, so the app works offline. Licences and axes were checked in Google Fonts' metadata on 2026-11-17.

| Role               | Face                                                                      | Settings                             | Used for                                                                                             |
| ------------------ | ------------------------------------------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Display, sparingly | **Anek Latin**, with Anek Devanagari and Anek Malayalam (Ek Type, Mumbai) | width 75 (condensed), weight 600–700 | Tenant name, conversation token numbers, the custody stamps, pane titles, the one analytics headline |
| Body               | **Noto Sans**, with Noto Sans Devanagari, Malayalam and Arabic            | weight 400 and 600                   | Messages, lists, forms, all prose                                                                    |
| Utility            | **Martian Mono**                                                          | width 87.5, weight 400–500           | Times, IDs, order numbers, costs, latency, token counts, key caps, delivery status                   |

Why these faces:

- **Anek** comes from an Indian foundry, designed with its Indic scripts rather than bolted onto a Latin face. At width 75 its numerals read like a token-slip or a painted shop sign, and the stamps stay narrow in a dense list.
- **Noto Sans** keeps vertical metrics matched across all five scripts. A Malayalam row and an English row in the 300-conversation list therefore keep the same height, and every script renders in a proper face by construction.
- **Martian Mono's** fixed-width figures line up in the day book and the receipt panel. At semi-condensed width it stays legible at 11 px.

Scale (px): 11 mono meta · 12 labels · 13 list text · 14 message text · 16 thread title · 20 stamps and pane titles (display) · 28 analytics headline (display).

Line height:

- 1.45 for Latin, 1.65 for Devanagari and Malayalam, 1.7 for Arabic.
- Set with `:lang()` on each message, because messages carry the detected language.
- Message text uses `dir="auto"`, so Arabic aligns right inside a left-to-right interface.

Uppercase appears **only inside stamps** (letter-spacing 0.06em), because real rubber stamps are uppercase. All other copy is sentence case.

## 3. Signature: the custody margin

The ruled margin of a khata ledger, repurposed. Every conversation has exactly one holder, and the margin is that holder's mark, wherever the conversation appears.

| State               | Margin                            | Stamp                                                               | Reads as                |
| ------------------- | --------------------------------- | ------------------------------------------------------------------- | ----------------------- |
| `assistant`         | 2 px Graphite rule `╎`            | none in the list (quiet: it is most rows)                           | pencil                  |
| `waiting_for_human` | 6 px Stamp-red diagonal hatch `▒` | `WAIT 4m` with live elapsed time                                    | an unfilled ledger line |
| `human`             | 6 px solid Ballpoint `█`          | holder's initials `PR`; filled if it's you, outlined if a colleague | signed in pen           |
| `closed`            | none                              | `Closed 14:40` in mono                                              | filed                   |

Where it appears:

1. **Conversation list.** The margin is the row's left edge. Rows are grouped **Waiting** (oldest first, always on top), **Mine**, **Others**, then **Assistant**. You can read the column of marks down the left like a ledger.
2. **Thread.**
   - The margin runs down the left of the message history, segment by segment.
   - Each change of holder is ruled across the thread as a ledger entry: time, new holder, who did it, and why, taken from the transition log (`╞═ 14:26 Waiting for a person · asked for one ═`).
   - Scrolling a thread shows its custody history without opening anything.
3. **Thread header.** A large "Held by" stamp, with the one action that changes it beside it: **Take over (T)**, **Hand back to assistant (H)**, **Assign… (A)**.
4. **Composer.** Locked while the assistant holds the conversation ("The assistant is replying to Sneha. Take over to write yourself."). Internal notes stay available.
5. **Analytics.** "Who held conversations, by day" uses the same three marks.

Motion: only when custody changes.

- In the thread, the new margin segment draws down from its ledger entry (180 ms, ease-out).
- In the list, the row moves to its new group (150 ms).
- With `prefers-reduced-motion`, both changes are instant.

## 4. Layout and wireframes

Legend: `╎` assistant · `▒` waiting · `█` person. Numbers in the wireframes are layout filler. The real screens show only stored, measured values.

### Inbox at 1440 px

Three panes:

- **Queue** (fixed 320 px): the conversation list.
- **Thread:** on the white Sheet, flexible width.
- **Context** (fixed 300 px): customer details, the last order looked up, and "Explain this reply" for the selected message.

Panes are separated by single rules. There are no cards and no shadows; the only shadow token is for menus and popovers.

```text
┌────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Qamar Phone Corner ▾   Inbox  Knowledge  Analytics  Settings              Connected · 14:32    Priya R ▾       │
├───────────────────────────────┬────────────────────────────────────────────────────┬───────────────────────────┤
│ Search conversations       /  │ 047  Fatima Al Mansoori         +971 5•• •••• 12   │ Customer                  │
│ Waiting 2   Mine 2   All 312  │ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓   Hand back   H   │ Fatima Al Mansoori        │
│───────────────────────────────│ ┃ HELD BY  PRIYA R  since 14:28┃   Assign…     A   │ Arabic, English           │
│ Waiting for a person          │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛   Close       C   │ 4 conversations since Oct │
│▒ 051 Rahul Nair      ▒WAIT 4m▒│ Reply window open · 21 h 40 m left       ar  en    │───────────────────────────│
│▒     ml  The cake I ordered…  │────────────────────────────────────────────────────│ Order KB-2291             │
│▒ 049 +91 98•• ••07   ▒WAIT 1m▒│╎ 14:20  Customer   Did my order arrive?            │ Shipped 15 Nov · Aramex   │
│▒     hi  bhai screen guard ka…│╎                   Order no. KB-2291               │ Delivery date: not given  │
│ Mine                          │╎ 14:20  Assistant  Your order KB-2291 shipped on   │───────────────────────────│
│█ 047 Fatima Al Mansoori  [PR] │╎                   15 Nov with Aramex.     Explain │ Explain this reply   14:20│
│█     ar  I want to talk to a… │╎ 14:26  Customer   I want to talk to a person.     │ Passages ............... 2│
│█ 044 Joseph Mathew       [PR] │╞═ 14:26  Waiting for a person · asked for one ═    │  Delivery policy §2   0.82│
│█     ml  Can I change the da… │▒                                                   │  Courier partners     0.74│
│ Assistant  288                │╞═ 14:28  Priya R took over ═════════════════════   │ Tool  lookup_order        │
│╎ 046 Sneha Kurian       14:31 │█ 14:29  Priya R    Hello Fatima, I'm checking      │       → shipped, no ETA   │
│╎     en  Do you have eggless… │█                   with the courier now.           │ Latency ........... 1.84 s│
│╎ 045 Mohammed Rafi      14:30 │█ ┌ Internal note · not sent ────────────────┐      │ Tokens ....... 2,341 / 118│
│╎     hi  Mera order kahan hai?│█ │ Aramex AWB ends 7781. Called 14:31.      │      │ Cost ............. $0.0031│
│╎ 043 Aisha Siddiqui     14:22 │█ └──────────────────────────────────────────┘      │                           │
│╎     en  Is the S24 in stock? │────────────────────────────────────────────────────│                           │
│  … 284 more                   │ Reply to Fatima…                         Send ⏎    │                           │
│                               │ Note N    Template    Attach    Voice reply: off   │                           │
└───────────────────────────────┴────────────────────────────────────────────────────┴───────────────────────────┘
```

### Thread: other ownership states

A: the assistant holds the conversation, so the composer is locked and "Take over" is the action. B: the 24-hour window is closed, so free text is replaced by the template picker.

```text
┌────────────────────────────────────────────────────┬────────────────────────────────────────────────────┐
│ A. The assistant holds it                          │ B. Window closed, a person holds it                │
│────────────────────────────────────────────────────│────────────────────────────────────────────────────│
│ ┌──────────────────────────┐                       │ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━┓                       │
│ │ HELD BY  ASSISTANT       │   Take over   T       │ ┃ HELD BY  ANIL K  2 d     ┃  Hand back   H        │
│ └──────────────────────────┘                       │ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━┛                       │
│ Reply window open · 23 h 51 m left                 │ Reply window closed 26 h ago                       │
│────────────────────────────────────────────────────│────────────────────────────────────────────────────│
│╎ 10:02  Customer   Do you have eggless             │█ 15 Nov  Anil K     Your cake is ready for         │
│╎                   chocolate cake for Saturday?    │█                   pickup any time after 4 pm.     │
│╎ 10:02  Assistant  Yes. Eggless chocolate is       │█ 17 Nov  Customer   (no reply since)               │
│╎                   ₹850 for 1 kg. Order by         │█                                                   │
│╎                   Thursday 6 pm.     Explain      │█                                                   │
│╎ 10:03  Assistant  is writing… 1.2 s               │█                                                   │
│────────────────────────────────────────────────────│────────────────────────────────────────────────────│
│ The assistant is replying to Sneha.                │ Free text can't be sent: WhatsApp closed the       │
│ Take over to write yourself.   Take over  T        │ 24-hour window 26 h ago. Send an approved          │
│ Add internal note  N                               │ template to reopen it.                             │
│                                                    │ [ Reopen conversation (Malayalam) ▾ ]  Send        │
└────────────────────────────────────────────────────┴────────────────────────────────────────────────────┘
```

### At 390 px

- The list and the thread are separate screens.
- The "Held by" stamp stays sticky under the thread header.
- Actions move to a bottom bar.
- Context opens as a full-height sheet from "Details".

```text
┌────────────────────────────────────┬────────────────────────────────────┐
│ Qamar Phone Corner ▾       Priya   │ ‹ Inbox   047 Fatima Al M…  Details│
│ Search                         /   │ ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓   │
│ Waiting 2  Mine 2  All 312         │ ┃ HELD BY  PRIYA R  since 14:28┃   │
│────────────────────────────────────│ ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛   │
│ Waiting for a person               │ Window open · 21 h 40 m left       │
│▒ 051 Rahul Nair       ▒WAIT 4m▒    │────────────────────────────────────│
│▒     ml  The cake I ordered…       │╎ 14:20 Customer                    │
│▒ 049 +91 98•• ••07    ▒WAIT 1m▒    │╎ Did my order arrive?              │
│▒     hi  bhai screen guard ka…     │╎ Order no. KB-2291                 │
│ Mine                               │╞═ 14:26 Waiting · asked for one ═  │
│█ 047 Fatima Al Mansoori   [PR]     │╞═ 14:28 Priya R took over ══════   │
│█     ar  I want to talk to a…      │█ 14:29 Priya R                     │
│ Assistant  288                     │█ Hello Fatima, I'm checking with   │
│╎ 046 Sneha Kurian        14:31     │█ the courier now.                  │
│╎     en  Do you have eggless…      │────────────────────────────────────│
│                                    │ Reply to Fatima…          Send     │
│                                    │ Hand back   Assign   Note   ⋯      │
└────────────────────────────────────┴────────────────────────────────────┘
```

### Knowledge base

- **Left:** a ledger of sources with their ingestion state, which is Queued, Reading (with progress), Ready or Failed. A failure says why and what to do.
- **Right:** the selected source and its passages.
- **"Try a question":** runs retrieval and shows exactly which passages the assistant would read, with scores. Owners can check the assistant's knowledge before customers do.

```text
┌──────────────────────────────────────┬──────────────────────────────────────────────────────────┐
│ Knowledge          Add source ▾      │ Warranty policy.pdf                                      │
│ All 41  FAQs 38  Files 2  Catalogue 1│ Uploaded 12 Nov by Anil K · 6 pages · version 3          │
│──────────────────────────────────────│ Ready · 14 passages                                      │
│ Warranty policy.pdf          Ready   │──────────────────────────────────────────────────────────│
│   14 passages · 12 Nov               │ Try a question as a customer would ask it                │
│ Price list November.csv      Ready   │ [ bhai screen guard ka warranty kitna hai          ]     │
│   212 products · 15 Nov              │ The assistant would read:                                │
│ Returns and exchanges.docx Reading…  │  0.81  §3  Screen guards and cases are not covered…      │
│   page 3 of 5                        │  0.77  §1  All phones carry a 12-month manufacturer…     │
│ Delivery areas.pdf          Failed   │  0.52  FAQ  Do you repair screens?                       │
│   No text found: this looks like a   │──────────────────────────────────────────────────────────│
│   scanned PDF. Upload a text PDF     │ Passages                                                 │
│   or paste the areas as an FAQ.      │  §1  All phones carry a 12-month manufacturer warranty   │
│ FAQ  38 entries                      │       from the date on the invoice. Keep the invoice.    │
│   Edited 16 Nov by Priya R           │  §2  Warranty claims go to the brand's service centre;   │
│                                      │       we book the visit for you at no charge…            │
└──────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

### Analytics

There are no KPI tiles. The page has:

- one sentence that states the result;
- one custody chart;
- a day-book table;
- handoff reasons as a ranked list, beside a summary of human response times.

```text
┌──────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Analytics      Last 7 days ▾      Compared with the 7 days before                                │
│                                                                                                  │
│ The assistant resolved 412 of 538 conversations (77%) without a person.                          │
│ First replies: median 2.1 s, p95 6.8 s.  Cost per conversation: $0.0040.                         │
│──────────────────────────────────────────────────────────────────────────────────────────────────│
│ Who held conversations, by day              ╎ assistant only   █ a person took part   ▒ waiting  │
│  11 Nov  ╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎██████████▒                                           │
│  12 Nov  ╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎██████████████                                           │
│  13 Nov  ╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎╎████████▒▒                                          │
│  …                                                                                               │
│──────────────────────────────────────────────────────────────────────────────────────────────────│
│ Day book                                                                                         │
│  Date     Conversations  Resolved by assistant  Handoffs  Median reply  p95 reply  Cost / conv   │
│  17 Nov              82            63  (77%)        19        2.0 s      7.1 s      $0.0041      │
│  16 Nov              79            61  (77%)        18        2.2 s      6.5 s      $0.0039      │
│  …                                                                                               │
│──────────────────────────────────────────────────────────────────────────────────────────────────│
│ Why conversations went to a person          Time to first human reply                            │
│  Asked for a person          61  ████████    median 3 m 40 s   p95 21 m                          │
│  Not in the knowledge base   38  █████       outside opening hours: next morning, 9:04           │
│  Order not found             14  ██                                                              │
│  Out of scope, insisted       9  █                                                               │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## 5. Details

### "Explain this reply" is an itemised receipt

- It opens in the context pane, not a modal, for the selected assistant message.
- It lists, in Martian Mono with dotted leaders:
  - the passages retrieved, with scores, each linking to the knowledge source;
  - each tool call with its arguments and result;
  - latency, tokens in and out, and cost.
- Cost and latency read naturally as a bill, which is the counter's own format.

### Messages are ledger lines, not bubbles

- Each line shows the time (mono), the sender label (in custody colour) and the text.
- Everything is left-aligned, apart from text that is itself right-to-left.
- No bubble shapes, no WhatsApp green, no tick marks.

### Internal notes are carbon copies

- A Carbon-copy yellow slip with a dashed top edge, like a tear-off duplicate.
- Labelled "Internal note · not sent to the customer".

### Voice notes

- An audio player with its transcript beside it.
- The transcript's language is shown in mono (`ml`), with "Transcribed by Amazon Transcribe" or "Transcript from simulator" in mock mode.
- Voice replies show the text that was spoken, plus "Sent as voice" when Polly was used, or "Sent as text: no voice for Malayalam".

### The 24-hour window

- Shown under the header stamp as "Reply window open · 21 h 40 m left".
- When closed, it turns Stamp red ("Reply window closed 26 h ago") and the composer becomes the template picker.

### States, each designed

| State                   | Treatment                                                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Loading                 | Static outline rows with "Loading conversations…" in mono. No shimmer                                                                    |
| Empty inbox             | "No one is waiting. The assistant is handling 12 conversations." with a link to the Assistant group                                      |
| Empty knowledge base    | "The assistant can only answer from what you add here. Add your first FAQ or upload a price list." with an "Add source" button           |
| Error loading           | "Couldn't load conversations: the server didn't answer. Retrying in 5 s." with a "Retry now" button                                      |
| Reconnecting            | The top-bar connection label changes to "Reconnecting…". The list keeps its last state, and a ruled line marks "Updates paused at 14:32" |
| Send failed             | The message line shows "Not sent: WhatsApp rate limit. Retrying 2 of 5" and, once retries are exhausted, "Failed: Retry"                 |
| Window closed           | Thread B above                                                                                                                           |
| 2,000-character message | Collapsed after 12 lines with "Show full message (2,000 characters)"                                                                     |
| 300 conversations       | A virtualised list, sticky group headers with counts, `j`/`k` keep focus in view                                                         |
| Assistant writing       | "is writing… 1.2 s" in Graphite on the next ledger line                                                                                  |
| Mixed scripts           | Each message carries `lang`, so line height and font follow the script                                                                   |

### Keyboard first

- `j`/`k` move through the list, `Enter` opens a conversation, and `T`/`H`/`A`/`C` take over, hand back, assign and close.
- `N` adds a note, `E` explains the selected reply, `/` searches, `g i` / `g k` / `g a` / `g s` switch sections, and `?` lists every shortcut.
- Each shortcut is shown as a mono key cap beside its button.
- Focus is a 2 px Ink outline with a 2 px offset, never removed.

### Shape

- 4 px radius on buttons and inputs, 2 px on stamps.
- Panes and rules are square, but the content isn't set in newspaper columns.
- One shadow token, for menus only.

### Copy

- Sentence case, plain verbs, and buttons that say what happens: "Take over", "Hand back to assistant", "Send template", "Add source".
- Errors state what happened and what to do next. They don't apologise.

### Real content in the seed data

- Arabic: "هل وصل طلبي؟ رقم الطلب KB-2291"
- Malayalam: "ഞാൻ ഓർഡർ ചെയ്ത കേക്ക് ഇതുവരെ എത്തിയില്ല"
- Hindi: "क्या आपके पास iPhone 15 का कवर है?"
- Hinglish: "bhai screen guard ka warranty kitna hai?"
- English: "Do you have eggless chocolate cake for Saturday?"

## 6. Self-review: what I changed from my first draft

I reviewed my first draft against "what would I produce for any SaaS helpdesk?" and replaced each part that matched:

1. **A brand accent was replaced by "colour means custody".**
   - The draft had a blue-violet primary colour for buttons, links and selection.
   - It also had a status pill on every row (Open, Pending, Resolved).
   - Every helpdesk looks like that, and the brief rules out pill badges everywhere.
   - Now no colour is decorative: blue means a person holds the conversation, and only the custody marks are stamped.
2. **Chat bubbles were replaced by ledger lines.**
   - The draft had grey bubbles on the left and coloured bubbles on the right, the chat-app default and too close to WhatsApp.
   - Ledger lines with sender labels are denser and keep the custody margin readable.
3. **KPI tiles were replaced by a sentence, a custody chart and a day book.**
   - The draft analytics had four big-number tiles and a line chart: the marketing look the brief rejects.
4. **Inter and JetBrains Mono were replaced by Anek, Noto and Martian Mono.**
   - The default pairing says nothing about where this product is used.
   - Anek is from an Indian foundry, Noto keeps five scripts even, and Martian Mono keeps figures aligned.
5. **An "Explain" modal with tabs became an itemised receipt in the side pane.**
   - It stays visible while you read the thread, and it uses the counter's own format for cost.

Considered and rejected:

- Literal ledger paper (cream with red margins): one of the three looks AI design converges on.
- Dot-matrix railway-ticket type for IDs: illegible at 11 px.
- Brass token coins as row markers: decorative, and they carry no information.

**The one risk:** no brand colour and no bubbles. Staff used to chat apps may find ledger lines unfamiliar at first. The sender labels, the custody colours and the margin are there to carry that. I'll check it in the Playwright screenshots and with you before more screens follow.

## 7. Open points for you

1. **Product name.** "Support desk" is a working title. A name helps the README and the demo, but it's your call.
2. **Demo tenant names.** Qamar Phone Corner and Kayal Bakes are invented. Swap them if you prefer others.
