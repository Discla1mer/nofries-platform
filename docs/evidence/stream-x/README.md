# Stream X manual checks

A-024 affects the public sample result. The fixed priority groups still come first. Within a group, missing checks come before partly implemented checks. The fictional sample test compares the displayed gaps with the application's ranking. #470 already revised the dashboard wording. #480 explains Not applicable answers. Both PR heads retained the original fragment in the sample.

## D-014 on Home and Managed IT

Inspected both live pages in Chromium using same-origin GETs only. The release changed during the initial baseline. Local measurements below use main at 728e25c plus the Stream X changes, with the public accessibility gate's signed-out API fixtures. Each viewport is 900 CSS pixels tall.

| Page | Width | Document width | Tab stops in order | Lowest sampled text contrast after changes |
|---|---:|---:|---:|---:|
| Home | 375 | 375 | 14 | 5.20:1 |
| Home | 1280 | 1280 | 20 | 5.20:1 |
| Managed IT | 375 | 375 | 22 | 5.15:1 |
| Managed IT | 1280 | 1280 | 27 | 5.15:1 |

Stream R (#485, 6fa031f) recorded two incomplete ARIA nodes on Home and one on Managed IT at each width. All three were generic containers with author-supplied names. Adding a group role exposes the intended names in Chromium's accessibility tree. The Managed IT heading itself already had an accessible name. No heading edit was needed.

| Page | Accessibility tree excerpt after the change |
|---|---|
| Home | group “Your account”, group “Example assessment topics” |
| Managed IT | group “Available by arrangement”, containing the level-three heading of the same name |

At both widths the first Tab reached “Skip to content”. Enter focused the content target. Each subsequent keyboard stop had a solid 3px outline. The accessibility tree had zero unnamed links, buttons or disclosure controls. Space opened “Site version”, Enter closed it, and reverse Tab from the end returned to its summary. Footer links kept destinations available when the compact header hid links. Document width matched viewport width in all four local and live renders.

Axe's targeted ARIA and contrast rules reported zero violations locally after the changes. Only contrast remained incomplete (Home 31/32 nodes at 375/1280, Managed IT 10/10). An incomplete contrast rule on paper is inconclusive. To measure actual ink, compare full-page screenshots before and after temporarily making text fill transparent, following font readiness. For each visible text range, select changed pixels within 8 RGB levels per channel of the computed foreground and calculate WCAG relative luminance against the corresponding background pixels. This samples glyph interiors at these layouts, rather than every possible placement on the texture.

One verified failure was the Managed IT set-up price note at desktop. Its lowest sampled ratio rose from 4.44:1 to 6.47:1. At 375px it rose from 5.20:1 to 7.58:1. #478 covers Home readability, #479 covers Managed IT service wording and #485 covers the paper on other pages. These edits preserve their scope.

These observations cover signed-out Chromium at the two listed sizes. Screen-reader speech, authenticated states and other browser engines were outside the checks.
