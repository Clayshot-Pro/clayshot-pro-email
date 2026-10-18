# Security Policy

## Reporting a vulnerability

Please do **not** disclose suspected vulnerabilities, exploit details, credentials, sensitive infrastructure information, or proof-of-concept attack steps in a public issue, pull request, discussion, or other public channel.

Use GitHub's private vulnerability reporting / Security Advisory flow for this repository when available. If that option is unavailable, contact the repository owner privately through the contact information associated with this project.

When reporting, include only the information needed to understand and reproduce the issue safely, such as:

- the affected component or route
- the observed security impact
- the conditions required to reproduce it
- a minimal, non-destructive reproduction
- suggested remediation, if known

Do not access, modify, retain, or disclose mailbox contents, credentials, authentication material, connected-account data, or other private user information beyond what is strictly necessary for a good-faith report.

## Scope

Security reports concerning the application source, authentication/session handling, email processing, attachment handling, provider integrations, deployment configuration, or accidental secret exposure are welcome.

Self-hosters may test their **own** instances. Problems that are specific to a self-hosted deployment's configuration (its Cloudflare account, DNS, secrets or providers) should be fixed by its operator; report issues in the software itself here.

The public visibility of this source code does not authorize security testing against the original production service or anyone else's instance, infrastructure, accounts, users, or third-party providers. Do not perform denial-of-service testing, credential attacks, social engineering, destructive testing, data extraction, or attempts to access data that is not yours.

## Disclosure

Please allow the repository owner a reasonable opportunity to investigate and remediate a reported issue before any public disclosure. Publication or use of this source code remains subject to the repository's `LICENSE`.
