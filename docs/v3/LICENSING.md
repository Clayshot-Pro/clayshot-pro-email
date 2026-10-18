# Licensing change for v3

> **Design document.** Written before implementation; where it differs from the code, the code and the [README](../../README.md) win. Since v3.05 instance settings live in D1 (not `.env` vars), and since v3.06 integration keys are managed in Admin → Keys. Setup steps are in the [README](../../README.md).

**Document status:** Option B applied to [`LICENSE`](../../LICENSE) on `v3.05`: free self-hosting for personal and internal organizational use (including commercial), credit required, no redistribution, no hosting for others (paid or free), no paid services. **This is not legal advice.**

## Decision

- Others **may use** the software (run their own instance), **including commercially**.
- Use is conditional on **giving credit** (attribution), as defined below.
- Others **may not redistribute** the software.
- **No paid services:** nobody may sell or charge for access to an instance or a service built on it. "Commercial use" means a business running its own instance for its own staff, not selling it to others.

## What the new licence needs to say

| Topic | Position |
| --- | --- |
| Run / deploy your own instance | **Allowed** |
| Modify for your own instance | **Allowed** (configuration is through `.env`, but private code changes are allowed too) |
| Personal use | **Allowed** |
| Commercial use, e.g. a company running it for its own staff | **Allowed**, with attribution |
| Attribution | **Required**: see [Attribution requirement](#attribution-requirement) |
| Redistribute source or builds, modified or not | **Prohibited** |
| Publish a public fork with changes | **Prohibited** (it's redistribution) |
| Offer it as a hosted service to third parties (SaaS / mail hosting for others), paid or free | **Prohibited** |
| Charge anyone for access to, or use of, an instance | **Prohibited**: no paid services built on the software |
| Sublicense, sell, rent | **Prohibited** |
| Use the "LTM" name or logo as your instance's brand | **Not granted**. Rebrand through the v3.04 branding settings; the attribution line is the one permitted use of the name |
| Remove copyright/licence notices | **Prohibited** |
| Warranty / liability | None. Provided as is |
| Termination | Automatic on breach, with a 30-day cure period for a first violation |

## Attribution requirement

Every running instance must:

1. **Show a visible credit** on the sign-in page and in **Settings → About**, reading "Powered by LTM Email Service" (or equivalent wording), linking to the project repository.
2. **Keep the copyright and licence notices** in the source and in the LICENSE file of any copy.
3. **Not present the software as the operator's own work**, e.g. in documentation, marketing or "about" pages for the instance.

Product impact (tracked in [CUSTOMIZATION.md](./CUSTOMIZATION.md#attribution-credit)): the credit line is rendered by the app itself, **can't be hidden or edited through branding settings or the admin lock**, and stays legible in every built-in theme. Removing it in code is a licence breach, not a configuration option.

### Open questions for the owner

1. **GitHub forks:** GitHub's Terms of Service let users fork public repositories on GitHub. The licence can't override that, but it can say forks are only for receiving updates and must not be used to publish modifications. Recommend that self-hosters clone into a private repo instead (as [SELF_HOSTING.md](./SELF_HOSTING.md) does).
2. **Contributions:** if you ever accept pull requests, add a short clause that contributions are licensed to you under terms that let you keep the project's licence.

## Option A — standard licence: PolyForm Internal Use 1.0.0

The [PolyForm Project](https://polyformproject.org/) publishes lawyer-drafted source-available licences. **PolyForm Internal Use** allows use and changes for internal purposes and **grants no distribution rights**.

- **Pros:** reviewed by lawyers, recognized by name.
- **Cons:** it only requires passing on the licence notice. It has **no visible-credit requirement**, so it doesn't meet the attribution decision unless terms are added, and adding terms gives up most of the benefit of a standard licence. Its wording is also built around a business's internal use, so check that it clearly covers individuals.

## Option B — custom licence (draft, recommended)

```text
LTM EMAIL SERVICE — SELF-HOSTING LICENSE (DRAFT)

Copyright (c) 2026 Sanghyuk Mo. All rights reserved except as granted below.

1. Grant. Subject to this license, including the attribution conditions in
   section 2, the copyright holder grants you a worldwide, non-exclusive,
   non-transferable, non-sublicensable license to download, install,
   configure, modify, and run the software to operate your own instance,
   for your personal use or for the internal use of your organization,
   including a commercial organization.

2. Attribution. As a condition of this license, you must:
   (a) keep the software's built-in credit ("Powered by LTM Email Service",
       linking to the project repository) visible to users of your instance
       on the sign-in page and in the application's settings or about screen,
       or, if you modify those screens, display an equivalent credit in a
       comparably visible place;
   (b) keep all copyright, license, and attribution notices in the source
       code and in every copy; and
   (c) not represent the software as your own work.

3. Restrictions. You may not, in whole or in part, modified or unmodified:
   (a) distribute, publish, redistribute, sublicense, sell, rent, or lease
       the software or source code, or make it available to any third party;
   (b) publish your modifications, including in a public repository or fork;
   (c) provide the software, or a service substantially based on it, to third
       parties as a hosted or managed service, whether or not for a fee;
   (d) sell, or charge any fee for, access to or use of the software, an
       instance of it, or any service substantially based on it;
   (e) remove, hide, or alter the credit or notices required by section 2;
   (f) use the names "LTM", "LTM Mails", "LTM Email Service", or related
       logos as the name or branding of your instance or product, except in
       the credit required by section 2 or to truthfully state the origin of
       the software.

4. Third-party components. Components included under their own licenses
   remain subject to those licenses.

5. Termination. This license terminates automatically if you breach it. If
   you cure a first breach within 30 days of notice, your license is
   reinstated. On termination you must stop using the software and delete
   your copies.

6. No warranty. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
   KIND, EXPRESS OR IMPLIED, INCLUDING MERCHANTABILITY, FITNESS FOR A
   PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT.

7. Limitation of liability. TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE
   COPYRIGHT HOLDER IS NOT LIABLE FOR ANY CLAIM, DAMAGES, DATA LOSS, OR
   OTHER LIABILITY ARISING FROM THE SOFTWARE OR ITS USE.

8. Other permissions. Any use not expressly permitted here requires prior
   written permission from the copyright holder.
```

## Recommendation

**Option B.** It's the only option that covers personal use, internal commercial use, the visible-credit requirement, the no-redistribution and no-paid-services rules, and the trademark point. Because it allows commercial use, have it reviewed before the v3.00 release.

## Files to update at release

- `LICENSE`: replaced with the chosen text.
- `README.md`: replace the "Source-visible, not open source … No permission is granted to use" banner and the License section with a summary of the new terms, including the attribution requirement.
- `SECURITY.md`: check that its wording still fits once others run instances (reports may now come from self-hosters about their own deployments).
- `THIRD_PARTY_NOTICES`: added if v3.04 adds any third-party icon set.
