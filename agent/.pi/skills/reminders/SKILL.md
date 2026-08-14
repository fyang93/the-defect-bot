---
name: reminders
description: Use for creating, updating, or repairing reminders and recurring events, especially birthdays, anniversaries, festivals, and lunar-calendar dates.
---

# Reminder and birthday scheduling

Use this skill whenever the user asks to add, change, inspect, pause, resume, or delete a reminder or recurring event.

## Canonical schema

Before changing event state, read the canonical schema at:

- `../../../system/schemas/events.schema.json` (relative to this skill directory)

Do not guess schedule field names and do not write `/system/events.json` directly. Use the deterministic event tools.

The schema distinguishes these recurring birthday schedules:

- Gregorian annual date: `{"kind":"yearly","every":1,"month":M,"day":D,"time":{"hour":H,"minute":m}}`
- Lunar annual date: `{"kind":"lunarYearly","month":M,"day":D,"time":{"hour":H,"minute":m}}`

For birthday events use `category: "special"` and `specialKind: "birthday"`, with local time semantics and the user's timezone. The annual month/day is the recurrence rule; `time` is only the notification time, not a one-time timestamp.

## Absolute versus local schedules

- **Absolute time**: a fixed instant such as a meeting. Use `timeSemantics: "absolute"` and a `once` schedule with an ISO 8601 `scheduledAt` including its offset. A later timezone change must not move the instant.
- **Local/relative schedule**: a recurring wall-clock rule such as every day at 09:00 or every Friday at 20:00. Use `timeSemantics: "local"` and the appropriate recurring schedule (`interval`, `weekly`, `monthly`, `yearly`, or `lunarYearly`). Recompute the actual instant in the target user's timezone for each occurrence.
- Reminder offsets such as “提前一天” are relative to the event occurrence, even when the event itself is absolute or local.

Resolve timezone in this order:

1. Use the requester/target user's timezone supplied in the current Feishu turn context.
2. Use the user's cached timezone when the current context is unavailable. Per-turn timezone-cache synchronization belongs to the runtime code, not to this skill's prompt logic.
3. If neither exists, ask the user or use an explicit timezone. Do not silently assume the server timezone.

The current bot turn can provide a requester-local time and timezone directly. Do not assume that a generic Feishu user profile endpoint exposes a reliable IANA timezone; the turn context is authoritative and the user JSON is the cache/fallback. The runtime should update that cache when the context timezone changes.

## Default birthday workflow

1. Extract the person, relationship, calendar type, month/day, and any leap-month detail.
2. Save durable person facts through `user_record_person` when the user's intent to remember is clear.
3. Use `event_create` with a yearly or lunar-yearly schedule. Never encode a birthday as a one-time date when it is intended to repeat annually.
4. Unless the user specifies another time, use 09:00 in the target user's local timezone resolved by the rules above.
5. Add four reminders with offsets:
   - `-20160` minutes: two weeks before
   - `-10080` minutes: one week before
   - `-1440` minutes: one day before
   - `0` minutes: the birthday itself
6. Use concise labels such as `提前两周`, `提前一周`, `提前一天`, and `当天`.
7. Base the reply only on successful tool receipts. If a schedule call fails, fix the schema rather than silently creating a different kind of reminder.

## Safety and edge cases

- Do not create a past one-time event for a recurring birthday; that can trigger or pause immediately.
- Ask only for missing information that is necessary to construct the recurrence. A person's name may be unavailable; `妈妈` or another explicitly supplied relationship is acceptable as the title.
- Preserve lunar dates as lunar dates. Use `lunarYearly`, including `isLeapMonth`/`leapMonthPolicy` when relevant; do not silently convert to a fixed Gregorian annual date.
- Do not create duplicate events after a successful receipt. If an earlier malformed event exists, pause or delete it through event tools when possible, then create the canonical event.
- Keep the default birthday reminder rule in this skill; do not store it as a per-user rule and do not create a separate one-time event to represent the rule. User-specific rules should be reserved for explicit overrides.
