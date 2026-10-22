# OpenSpec in PersonalSpace

OpenSpec **1.14.3** is installed globally on the setup machine. This repository uses the `spec-driven` schema with the core Codex workflow skills. Project context and delivery rules live in [config.yaml](config.yaml).

The existing [product specification](../PersonalSpace-Specification-v1.2.md) remains authoritative. [The project audit](../docs/project-audit.md) records implementation gaps. Setup does not convert the entire product document into implemented capability specs or mark existing work complete.

## Set up another machine

```powershell
npm install -g @fission-ai/openspec@1.14.3
openspec --version
openspec init --tools codex --profile core --no-animation
```

Run these from the repository root. Node 20.19+ is required by OpenSpec; this project's Node 22.13+ requirement is stricter. The generated `.agents/skills/openspec-*` files are committed. Initialization preserves the existing project configuration and refreshes the selected tool's skills.

## Use the workflow

Reload Codex after setup so it discovers the new project skills. Start with:

```text
$openspec-explore investigate the remaining transactional email delivery gaps
$openspec-propose reliable-transactional-email
$openspec-apply-change reliable-transactional-email
```

The other installed skills are `openspec-update-change`, `openspec-sync-specs` and `openspec-archive-change`. Select them from the Skills interface or name them in your request. Codex uses skills; OpenSpec does not install `/opsx:` command files for it.

Useful terminal commands:

```powershell
openspec list
openspec list --specs
openspec status --change reliable-transactional-email
openspec validate --all --strict --no-interactive
```

The change name above is an example, not an existing change. `specs/` holds established capability specifications, `changes/` holds active proposals/designs/tasks, and `changes/archive/` holds completed changes. They start empty intentionally. Add specs through real, scoped work; validation has no artifacts to check immediately after setup.

After upgrading the CLI, run `openspec update` from the project root, review the generated changes and commit them. Keep the documented version aligned with the generated skill metadata. Preserve the existing requirement to validate, commit and push completed features; do not operate the user's emulator without permission.

Official references: [installation](https://openspec.dev/docs/installation), [project configuration](https://openspec.dev/docs/project-config), [supported tools](https://openspec.dev/docs/supported-tools).
