# Synthetic mobile Overview review

Source: 79a519a7b380d01dc063cc2c2197d6055385c1ee. Baseline CSS: 3f72ac2c5bc1ebeab6e9716fc98aadc83d065725.

All data is synthetic. The actual dashboard/gateway documents, loader and protected UI are served over loopback GET routes. No sign-in, customer data, database or writes are used.

56 browser observations cover 375/390px, both documents, 100/200% text, enabled/empty/planned Actions, expanded disclosures and Services availability. Before: long header crops, undersized Overview and gateway chrome targets, and mid-word navigation wrapping. After: no overflow, clipping, targets below 44px, split navigation words, page errors or CSP violations. Scores remain unchanged when disclosures open.

Service status is in the existing Services destination, reached from Overview. The planned menu label and enabled Actions are separate states. The name fixture is 200 characters; owners include spaced and unbroken names; dates include 30 Sept 2026 and 31 Dec 9999.

823 targeted Jest tests pass. The older workspace-menu browser script times out at its native-history leave-dialog check (line 271), and the older overview-guidance script times out waiting for a guidance item (line 72), on both the candidate and clean main. Their unchanged desktop paths reproduce the same failures; both sets of receipts are included.

The PNGs ending in top/full show 375px viewport evidence; card PNGs retain their real content width within that viewport. Full-page 390px captures are also included. SHA-256 values are in manifest.json.
