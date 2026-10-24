# Browsing polish follow-up

## Behavior

- Creating a collection and adding media holds the media lock across initialization, creation, membership change and readback. Busy submissions are rejected before creating a collection. Confirmed creation remains visible if the add cannot be confirmed; confirmed membership remains visible if its readback fails. The form prevents duplicate submissions and stays usable for retry.
- Creator-list cards, counts, pagination and cache writes belong to the applied route, reading generation and access context. Pending retries cannot reveal a previous filter's results. Same-context refreshes may retain their existing results.
- Heart actions and liked/favorite content use content terminology in Chinese, English and Spanish. Costuan validation and source-archive/processing-directory recycling states have separate Chinese labels; raw status codes remain in collapsed technical details. Action eligibility is unchanged.
- Desktop sidebar interaction is a per-browser preference under More. Click-to-expand/collapse is the default, and remembers the explicit expansion choice. Hover remains an option with its existing 100 ms opening and 120 ms closing delay. Switching modes cancels stale timers and restores focus. Category expansion remains independent; small-screen navigation is unchanged and coarse-pointer devices retain an explicit toggle.
- Sidebar statistics have an additional 1.2 rem top gap. Attribution is a single link, “基于 Foldergram 构建”, with equivalent English and Spanish text.

## Verification boundaries

Regression tests reproduce the collection race and pending-retry stale results before the fixes. Coverage includes partial success, retry, media-level mutual exclusion, route/access changes, sidebar mode persistence, keyboard/pointer behavior, storage failures and three-language key consistency.

Production UI checks use an isolated static build with synthetic API responses. They do not modify the live library, creator labels, configuration, or collections. Deployment requires clean paired build identities and successful Verify checks for the exact candidate commit; local implementation and deployment evidence are recorded separately.

No schema, dependency, photo-preview or video-original-first changes are included. Full SQL pagination and formal production performance measurements remain separate work.
