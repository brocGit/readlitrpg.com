# Runbook: author decisions

Authors manage their own books from `/dashboard` (DESIGN §10, as built in §10.7). Almost everything runs without you. What reaches the Owner Inbox, and what to do with it:

| Inbox item | What happened | What to do |
|---|---|---|
| **New listing (unverified author)** | A T0 author submitted a book | Check it's LitRPG or progression fantasy and not a duplicate (the item links the author's profile, and any existing book it may match). **Approve** publishes it and emails the author. **Reject** with a note: the note is the reason they read. With `flags.auto_publish` on, it approves itself after `publish.t0_default_action_hours` (72) |
| **Verification by hand** | An author put their code somewhere we don't fetch (Royal Road, Amazon Author Central, Patreon, X, Facebook), or on a website that isn't on their profile yet | Open the page shown and look for the code shown. For a website, also make sure the site is really the author's (their books link to it, or it's their known domain). **Approve** verifies the profile (T1, audited). **Reject** with a note saying what was missing |
| **Author change** | A change that needs a check: a series change, a title change after release, a date change within 72 hours of release, or any edit from an unverified or restricted profile | Approve applies it as the author; reject tells them why (use the note). Date changes approve themselves after 24 hours; unverified authors' edits after 72 |
| **Second claim** | Someone claims a profile that already has members | Usually reject: the real author can ask the current owner for an invite. Approve only if you know the claimant is the author (it adds them as an owner; you can remove members on the profile page) |
| **An author reports a problem** | "Report a problem" on a book's dashboard page: a wrong change, a genre or co-author fix, a removal request | Fix it from the book's console page, then **Resolve** |

## The author page in the console

Console → **Authors** → a profile:

- **Trust level.** T0 unverified (everything waits), T1 verified (publishes at once), T2 trusted, T-1 restricted (everything waits). Changes are audited.
- **Verify: I know this author.** Owner override for authors you know personally. Audited.
- **Official links.** The author's own website and Bluesky handle. Only you can set them. A verification code found on one of these verifies the author straight away with no inbox item, so add a link only when you're sure it's theirs.
- **Members.** Remove anyone who shouldn't manage the profile. A profile always keeps one owner.

## Emails authors get

All transactional, from the jobs Worker: decisions (published, rejected, verified, claims, changes) within 5 minutes; one daily note from 17:00 UTC listing changes others made to their books; "Still on for …?" 14 and 3 days before a dated release; team invites. The templates are in `packages/email/src/templates/author.ts`.
