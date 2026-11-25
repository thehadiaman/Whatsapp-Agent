Webhook payloads copied from Meta's WhatsApp Cloud API webhook reference
(messages: text, audio, image; statuses: delivered, failed), checked on
2026-11-17. `inbound-image-username-only.json` is the image example with `from`
and `wa_id` removed, as Meta documents for users who adopted a username.
Both the product's parser and the simulator's payload builder are tested
against these, so the two cannot drift into agreeing with each other while
disagreeing with Meta.

`status-failed-live-2026-11.json` is not from the reference: it is a failed
status the live Cloud API sent to this project on 2026-11-25 (error 131031,
business not yet verified), with phone numbers and account IDs replaced by the
demo ones. It has fields the documented examples lack, such as
`recipient_logical_id` and `internal_1p_only_data`.
