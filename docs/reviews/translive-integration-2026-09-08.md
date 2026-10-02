# Hanyang Translive reverse engineering and Study integration feasibility

Inspected 2026-09-08 UTC. Scope: the single Translive viewer already opened by the user, its publicly served frontend files, and the current Study source. No production changes, presenter actions, microphone capture, raw-audio persistence, or new translation requests were performed.

## Conclusion

A native Study viewer adapter is technically feasible for this specific session. A standalone Node client successfully joined the normal public viewer protocol, received Korean history and live Korean updates, and retrieved existing Chinese translations. This is evidence beyond a source-only inference; it is not a completed Study integration or an iPad compatibility test.

The useful integration is to consume the school's existing captions. It does not require separately recognizing classroom audio on the student's iPad. Teacher-side audio capture is implemented separately from viewer display.

## Acquired evidence

- Frontend build: version `1.6.12`, bundle `main.2691c3be.js`.
- The bundle explicitly references `main.2691c3be.js.map`; both were served without login credentials. The map includes the application's TypeScript source content.
- Public worklets referenced by the application: `recorderWorkletProcessor.js` and `noiseFilterWorkletProcessor.js`.
- Temporary evidence and narrowly scoped inspection scripts are in `.tmp/translive-analysis/`. Proprietary source copies are analysis material, not proposed Study implementation or material for publication.
- `sources/index.json` maps flat extracted filenames to original paths.
- `public-observations.json` records selected non-secret HTTP headers and metadata.
- `viewer-probe-result.json` records aggregate event counts and payload field names. It stores no caption text, cookies, viewer credentials, guest identifiers, or raw audio.

## Observed architecture

```text
Presenter browser: selected microphone, optionally mixed with tab/system audio
  -> Web Audio / AudioWorklet / conditional voice-activity and noise processing
  -> Socket.IO recording_speech_stream
  -> School Translive backend: selected STT engine and language processing
  -> original caption + correction + translation events
  -> student Viewer, or a future authenticated Study relay and viewer
```

`hooks/useSessionInitializer.ts` requests microphone permission only for presenter routes. `/s/:transliveId` is the presenter route and requires a presenter token; `/v/:transliveId` is the viewer route.

The architecture gives the presenter control of the capture device. It does not establish whether this classroom uses a headset, lectern microphone, mixer, or laptop microphone, nor prove the audio quality contribution of each component.

## Current session and model evidence

The current session metadata reported:

| Field | Observed value |
|---|---|
| `engine` | `clova` |
| `openai_model` | `gpt-4.1-mini-2025-04-14` |
| `language_code` | `ko` |
| `recording_status` | `recording` |
| `viewer_public` | `true` |
| `has_password` | `false` |
| `enable_caption_download` | `true` |
| `created_from` | `lms` |

Metadata also includes `course_id` and `learningx_module_item_id`, providing concrete course/module association rather than requiring a title guess. Their precise mapping to Core course records needs validation during implementation.

The frontend's V2 path explicitly selects ElevenLabs when enabled; V1 includes comments describing Naver Clova for Korean. Both V1 and V2 were enabled at the server-option level. Thus ElevenLabs is a supported alternative, not the reported engine of this inspected session.

The OpenAI model field is a configuration observation. Backend source and outbound provider calls were not inspected; the exact division of translation versus transcript correction cannot be proven from that field. A transcript post-processing correction event was observed live.

## What the frontend actually does for poor audio

- Optional noise worklet: high-pass and low-pass filtering, simple captured-amplitude noise suppression, and a noise gate. This is not a DeepFilterNet-style neural enhancement model or a demonstrated classroom dereverberation system.
- Default noise-filter setting is disabled; default Silero VAD setting is also disabled. The presenter can change local settings, which were not inspected.
- The noise worklet is only inserted for the effective ElevenLabs/V2 path when enabled.
- The legacy energy-based VAD path is disabled for Korean/Clova by `isEnableVadLanguage("ko")`.
- The recorder targets 16 kHz. Its special case for an already-16-kHz AudioContext uses 8-bit output; its other downsampling path uses 16-bit output. Do not blindly copy this processing into Study.

These findings do not support attributing the successful classroom experience to a special far-field filter. The concrete difference from student-desk transcription is presenter-side capture plus a shared backend caption stream.

## HTTP and Socket.IO contracts

School origin: `https://learning.hanyang.ac.kr`.

| Purpose | Contract |
|---|---|
| Session metadata | `GET /translive-api-server/sessions/{id}` |
| Previously available languages | `GET /translive-api-server/sessions/{id}/language_codes` |
| WebSocket transport | Socket.IO, path `/translive-socket-server`, Engine.IO v4 |
| Session selection | query `translive_id` |
| Socket authentication | `token` for presenter; `vtoken` for identified viewer; `ptoken` for password-approved viewer |
| Original history, received | `stt_socket_event_caption_list` |
| Original live updates, received | `stt_socket_event_speech_recognized` |
| Original correction, received | `stt_socket_event_speech_post_processed` with `order` and `correctedText` |
| Existing translated history, requested | `translation_socket_event_translate_caption_list` with `{language_code:"zh-CN"}` |
| Translated history, received | `translate_socket_translate_caption_list_completed` |
| Live language subscription | `translation_socket_event_select_translate_language`, `{oldLanguages,newLanguages}` |
| Live translated partial/final events | `translate_socket_translate_caption_processing` / `translate_socket_translate_caption_completed` |

The ordinary translated-history request is explicitly documented in frontend comments as returning existing data without performing translation. The `..._force` event can request additional work and was not used. Live translation subscription was identified statically but was not exercised by the independent probe.

History entries contain `session_id`, `order`, `language_code`, `text`, `speech_start_ms`, and `speech_end_ms`. The frontend joins translations and originals by caption order. Live originals have an `is_final` flag; later correction events can still replace text.

## Live read-only probe result

A ten-second, single-session probe used the ordinary guest viewer handshake only after checking `viewer_public:true` and `has_password:false`. No browser cookies were extracted or reused.

| Observation | Result |
|---|---|
| Socket connection | Successful |
| Korean history | 103 entries, order 1–103 |
| Existing simplified Chinese history | 103 entries, order 1–103 |
| Live Korean recognition events | 18 |
| Post-processing correction events | 1 |
| Errors | 0 |

This proves transport access and structured data reception for this session. It does not measure recognition accuracy, end-to-end delay, full-class stability, or live Chinese delivery in our independent client.

## Embedding and authorization boundaries

- The viewer HTML response had no `X-Frame-Options` or `Content-Security-Policy` header at inspection time. An iframe is therefore a candidate, but actual embedding, login behavior, and iPad Safari behavior have not been tested.
- The JSON API responses advertised `Access-Control-Allow-Origin: https://learning.hanyang.ac.kr`. A Study page should not assume direct cross-origin REST reads will work. A server-side adapter can read the normal authorized viewer protocol; it must not impersonate a presenter or bypass a denied session.
- A successful public-viewer session does not establish access to every class. Password-protected sessions require their normal approval token; ended non-public sessions require viewer authorization. The source explicitly implements these guards.
- Viewing permission and a download-enabled flag do not by themselves establish a supported institution-wide API agreement. No public partner API contract was identified in the inspected material.
- Copying the public frontend cannot reproduce the school's server-side provider credentials or grant STT usage outside permitted school sessions.

## Proposed Study integration, not implemented

1. Add a school-subtitle source that accepts an existing authorized Translive viewer link and resolves metadata. Continue to obtain Hanyang course identity through Core.
2. A Core-side Socket.IO adapter consumes original history, live updates, corrections, and already-available translations, then exposes an authenticated read stream to Record. Do not expose an arbitrary URL proxy or copy presenter controls into Study.
3. Match captions by upstream session ID plus `order`; update rather than append on partial/final/correction events. Preserve source provenance and distinguish missing translation from finalized content.
4. If saving is enabled in a later implementation, keep transcript text in Record's Sites D1 and preserve the existing writer-lease/revision rules. No classroom audio storage is needed.
5. Extend writer model/source validation explicitly. `apps/record/src/types.ts` and `apps/record/services/schemas.ts` currently restrict new transcription sessions to `gpt-realtime-whisper`; do not label imported Clova captions as OpenAI transcription. Core's historical reader metadata already uses general model strings.
6. Verify normal live Chinese subscription, reconnect/history recovery, permission failure, duplicate prevention, course mapping, and physical iPad Safari use before delivery. Existing provider usage and school access must remain separate from any independently purchased transcription service.

Current recommendation: consume Translive output for classes where the teacher enables it. Keep separate microphone transcription only for classes without such a school stream. No application or deployment change has been made in this investigation.

## Follow-up: discover per-class links from Weekly Learning

The user identified the Weekly Learning page as the source of per-class TransLive links and asked whether the existing plugin interface can be reused. This was checked against the current callable Hanyang tools and the original upstream response inside the existing Core container. No application code or production configuration was changed.

### Current plugin calls, verified live

- `list_course_tabs(course_id: "214375")` returns the student-visible Weekly Learning tool `140` and Lecture/Attendance tool `138`.
- `list_learningx_modules(course_id: "214375", external_tool_id: "140")` returns all 16 weekly modules, including the two transcription entries visible in the user's screenshot.
- `list_modules` plus `list_module_items` for weeks 1, 2 and 3 returns the individual Canvas module item IDs and `externalUrl` LearningX entry URLs. The existing module-item interface can already expose ordinary safe external entry links, but those URLs are not necessarily final media or transcription viewer URLs.
- `get_learningx_attendance_item(course_id: "214375", item_id: "1273537", external_tool_id: "138")` identifies the second-week item as `type: "translive"`. The current weekly-list normalization instead reports `attendance_item` for the same nested content.

### Original upstream fields, verified read-only

The existing Core `LearningXReadClient` calls `GET /learningx/api/v1/courses/214375/modules`. Its response already contains the final transcription identifier at:

```text
module_items[].module_item_id
module_items[].content_data.item_id
module_items[].content_data.item_content_type = "translive"
module_items[].content_data.item_content_data.course_id
module_items[].content_data.item_content_data.translive_id
```

The existing attendance-item detail endpoint also returns `item_content_data.translive_id`. There is no need to scrape the rendered Weekly Learning screen or obtain a presenter token to discover these identifiers.

| Week | Module ID | Canvas module item ID | LearningX attendance item ID | TransLive viewer ID |
|---|---|---|---|---|
| 1 | `2877718` | `8587482` | `1262728` | `5239483487` |
| 2 | `2877719` | `8598607` | `1273537` | `7042679618` |

Both belong to course `214375`, `202620HY24372_ESG와SDGs이해`. The second ID independently matches the viewer URL supplied by the user. Using the previously verified viewer route, these map to `https://learning.hanyang.ac.kr/translive/v/{translive_id}`. Discovery of an ID must still be followed by the ordinary viewer-access check before subscribing to its captions; discovery does not establish public access to every session.

The temporary probe `.tmp/translive-analysis/probe-weekly.cjs` executes through stdin inside Core, opens the production database read-only, uses Core's existing credential decryption and LearningX client, and emits only selected non-secret metadata. No PAT, LTI JWT, cookie, credential-bearing URL, raw audio, or original full upstream response was exported. An initial attempt to initialize the full Auth service was blocked by SQLite read-only mode; the probe was revised to use the credential module directly without Auth initialization or any database writes.

### Minimum reusable change

1. Preserve nested content type before the generic `attendance_item` wrapper type in `LearningXReadClient.normalizeAttendance`.
2. Expose validated, nullable `moduleItemId` and a typed TransLive reference (viewer ID and credential-free viewer URL) in `learningx/types.ts` and `mcp/canvasOutputSchemas.ts`. Leave the existing generic `viewerUrl` semantics intact for compatibility. Construct only the known Hanyang viewer route from a validated numeric identifier; do not turn arbitrary upstream URLs into a credential-forwarding proxy.
3. Correct or explicitly separate duration units for TransLive before relying on `durationSeconds`: upstream `duration: 150` corresponds to the screenshot's 150-minute scheduled duration, while MP4 duration is expressed in seconds. Do not silently use the current generic duration field for session timing.
4. Reuse the same Core LearningX client in a backend discovery job, scoped to enabled courses. Join course → weekly module → module item → TransLive viewer, deduplicate by upstream IDs, and feed the separate caption adapter. Do not require the teacher or student to keep Study open, and do not hardcode today's viewer link as a semester-wide source.
5. The plugin's discovery-field extension and website caption persistence remain separate delivery steps. Run Core/plugin validators for the contract change; implement and verify reconnect, caption correction, existing Chinese retrieval and Record D1 ingestion before claiming automatic synchronization is running.

This check establishes that the upstream discovery data is available and the existing authenticated integration can retrieve it. Current plugin output does not yet expose the TransLive identifier, and background discovery/synchronization has not been implemented or deployed.

## Follow-up: sending our own audio to the school backend

The user's follow-up asked whether our capture client could use the school's recognition backend. Static inspection confirms an implementable presenter-side sequence: authenticated Socket.IO session, `recording_start` carrying `language_code` and optional `engine_version`, `recording_start_completed`, then binary `recording_speech_stream` chunks. Resume/pause/stop have separate events. This is a streaming protocol, not a discovered arbitrary file-upload REST endpoint. An existing file would need decoding and appropriately paced chunks; that path was not tested.

The essential prerequisite is a legitimately issued presenter token for a session the user is allowed to operate. The successful public viewer probe did not establish presenter authorization or permission to consume recognition quota.

The normal management URL explicitly embedded in the current frontend, `https://learning.hanyang.ac.kr/learningx/translive/sessions`, was opened in a separate tab using the user's existing Chrome context. Its visible title was `TransLive Access Denied` and it displayed `You do not have permission to access this page.` No attempt was made to bypass that denial or to invoke presenter events on the teacher's active session.

This establishes that the inspected management entry is unavailable in the current browser context. It does not prove that every other normal LMS launch path is unavailable. No authorized user-owned presenter session has been established, so sending our own audio is not currently verified or ready to implement against the school's backend. The next prerequisite would be a normal school-provided presenter/create-session entitlement or supported integration credential; this investigation neither obtained nor forged one. No audio was transmitted in this follow-up.
