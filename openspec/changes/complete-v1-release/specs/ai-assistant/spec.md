## Purpose

Provide optional text assistance over the user's own data with bounded access, explicit policy enforcement, verifiable actions and understandable recovery from failure.

## ADDED Requirements

### Requirement: AI requires consent and preserves offline intent

AI SHALL require verified email and explicit enablement, and send no user data to AI providers while disabled. Offline messages SHALL remain drafts and SHALL NOT auto-send on reconnect. Disabling AI SHALL preserve ordinary non-AI workflows and prevent queued classification from sending data.

#### Scenario: AI disabled with pending classification

- **WHEN** the user disables AI before a queued classification executes
- **THEN** no provider request is made and deterministic capture suggestions remain usable

#### Scenario: Offline draft reconnects

- **WHEN** connectivity returns with text in the offline composer
- **THEN** the text remains a draft until the user explicitly sends it

### Requirement: Tools use authenticated domain access

The assistant SHALL support the v1.0 read/search, note/create/append, task/create/update/complete, reminder, learning, money-create/correct/summary and content-summary tools from section 28. Tools SHALL use validated arguments and the authenticated user's domain authorization; model output SHALL NOT set identity, risk or scopes. Results SHALL cite accessible sources and report success only after confirmed execution.

#### Scenario: Model proposes another user's identifier

- **WHEN** a tool call references a foreign record or supplies an alternate user identity
- **THEN** access is rejected without disclosure and the assistant does not claim the action succeeded

#### Scenario: Write result lost during streaming

- **WHEN** a tool commits but the client stream disconnects
- **THEN** retry with the original action identity returns the committed result without a duplicate mutation

### Requirement: Confirmation policy follows risk and stated intent

The assistant SHALL apply sections 29-30, including money-create prerequisites and only the enumerated E1/E2/E3 exceptions. Questions SHALL not cause writes; ambiguous entities SHALL require resolution; writes derived from untrusted content SHALL require confirmation. External/high-impact and v1.1 bulk tools SHALL remain unavailable.

#### Scenario: Simple explicitly requested expense

- **WHEN** an explicit amount and resolved account/category/date qualify for direct creation without person/receivable splits
- **THEN** one expense is created with visible assumptions and Undo, as permitted by section 29.3

#### Scenario: Sensitive change outside a valid exception

- **WHEN** an existing money entry is changed outside the same-conversation 10-minute correction exception
- **THEN** execution waits for a confirmation card showing exact resolved changes

#### Scenario: Instructions embedded in a saved article

- **WHEN** retrieved content requests a tool call or data disclosure
- **THEN** the content is treated as untrusted data and cannot authorize the action

### Requirement: Pending confirmations are immutable and single-use

Confirmation SHALL reference exact validated server-held arguments, affected records and a 10-minute expiry. Only a separate authenticated user action SHALL confirm it; the model SHALL NOT confirm. Execution SHALL recheck ownership, versions and policy and remain idempotent.

#### Scenario: Confirm repeated or modified

- **WHEN** a client repeats confirmation or attempts to change its arguments
- **THEN** the same result is returned for a valid retry or the alteration is rejected, with no second or modified action

#### Scenario: Preview becomes stale

- **WHEN** an affected record changes before confirmation
- **THEN** the stale action is refused and a refreshed preview is required

### Requirement: Memory and conversation data remain user-controlled

Persistent memory SHALL require explicit user approval and support inspection, editing and deletion. Conversation retention SHALL follow the selected policy, include eligible data in export/erasure and minimize provider context. Sensitive data SHALL follow the specified encryption and redaction rules.

#### Scenario: Assistant infers a preference

- **WHEN** conversation suggests a lasting user preference
- **THEN** it is not stored as memory until the user explicitly approves it

### Requirement: AI execution is bounded and evaluated

Each turn SHALL enforce at most eight tool calls, 60 seconds overall, 10 seconds per tool and two retries limited to transient idempotent operations. Quotas, spend limits, cancellation and provider failure SHALL produce truthful recoverable states. Release SHALL require the section 37 gates on at least 300 versioned cases, including money, ambiguity, injection and cross-account tests.

#### Scenario: Quota or time limit reached

- **WHEN** a request reaches its permitted budget
- **THEN** further work stops, committed actions remain accurately reported and the client gets a clear limit state

#### Scenario: Prompt or model update regresses policy

- **WHEN** an evaluation run violates a required safety or correctness gate
- **THEN** the update cannot be enabled for release
