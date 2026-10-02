# Shared Canvas capability audit — 2026-09-21

Scope: the two independent school connections in the one private Study plugin, covering Core Canvas services, tool registrations, authorization, native Skills and public capability copy.

| Area | Finding and final implementation |
| --- | --- |
| Coursework reads | Already shared through `CanvasRestClient`: profiles, courses, assignments, own submissions/feedback, grades, announcements, modules, pages, discussions, files, calendars, Planner and weekly summaries. No second Berkeley implementation found. |
| Inbox send/reply | An inappropriate Hanyang-only restriction and fixed Hanyang POST host existed. Both now use the authenticated school's fixed Canvas host and the same service. |
| Message attachments | The initial attachment candidate duplicated send/reply tools. Removed those duplicate entry points; optional `attachment_ids` extend the existing send/reply schemas and service. |
| Files and submissions | One `CanvasWriteService` serves both schools. Upload storage origins are separately bound to each school. Upload receipts bind account, Canvas identity, purpose and assignment. |
| Connection validation | Shared `requireCanvasConnection` now validates account ownership, configured school and canonical host for standard reads and writes. |
| Authorization | One Study account grant, as explicitly requested by the user. Retained the old wire identifier for existing connection compatibility; retired per-feature scopes no longer block or appear in tool requirements. Authentication, school ownership and user-intent boundaries remain. |
| Hanyang extensions | LearningX, imported Portal timetable, Translive and saved Lecture ownership remain Hanyang-specific because the underlying systems/data are specific to that school. They are not alternative implementations of shared Canvas APIs. |
| Legacy names | `skill://hanyang-study/...` resource URIs are retained compatibility identifiers pointing to the single generated Study catalog, not a second implementation. |
| Capability instructions | Updated Core tool descriptions, initialization instructions, canonical Canvas/Study Skills, consent, privacy, terms and current README/AGENTS guidance. Historical release reports retain their original evidence. |

Validation: 303 Core tests, 72 Record tests, 12 release tests, typechecks/builds, plugin/Skill validation and Worker smoke passed. Parameterized file/submission and attachment send/reply tests exercise both schools. Live profile/course reads, native ChatGPT catalogs and real file upload/receipt checks are recorded in [the release report](../releases/2026-09-21-shared-coursework.md); no actual teacher message or assignment submission is used as a test.
