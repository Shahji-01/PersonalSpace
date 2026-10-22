## Purpose

Let users organize and continue learning from saved resources while safely retrieving metadata and preserving progress across interruptions and devices.

## ADDED Requirements

### Requirement: Metadata fetching cannot reach private network targets

URL fetching SHALL allow only supported HTTP(S) destinations, validate resolved addresses at every connection/redirect, reject private/reserved network destinations and enforce redirect, time and response-size limits. Failed fetches SHALL preserve the saved resource and expose a retryable or terminal metadata state.

#### Scenario: Public URL redirects to a private address

- **WHEN** metadata retrieval receives a redirect to an internal or reserved destination
- **THEN** retrieval stops before connecting to that destination and the resource remains saved without unsafe metadata

#### Scenario: DNS resolution changes

- **WHEN** a hostname resolves to an unsafe address or changes between validation and connection
- **THEN** the fetch cannot use an unvalidated connection target

### Requirement: Users can organize and edit learning resources

Users SHALL create, rename, move and remove collections/resources, select the intended collection, handle URL duplicates explicitly, and edit title/status/progress with account-scoped version checks. Offline edits SHALL remain pending until replay succeeds or a recoverable conflict is shown.

#### Scenario: Choose a collection other than the first

- **WHEN** a user files a resource into a selected collection
- **THEN** it appears in that collection across synchronization and is not silently assigned to a default collection

#### Scenario: Stale resource edit

- **WHEN** an offline edit conflicts with a newer remote version
- **THEN** both the saved remote value and the user's recoverable intended change remain available

### Requirement: Playback supports resume and manual fallback

Supported in-app media SHALL persist position and automatic progress, resume from confirmed progress and expose accessible controls. Unsupported, blocked or offline playback SHALL offer a clear fallback and manual progress without fabricating completion.

#### Scenario: Playback interrupted

- **WHEN** a user leaves a supported video and later returns
- **THEN** playback offers resume from persisted position and retains the resource's current status

#### Scenario: Provider refuses embedding

- **WHEN** the media provider blocks in-app playback
- **THEN** the UI explains the limitation, offers external opening when possible and retains manual progress controls

### Requirement: Playlist expansion is resumable and visible to sync

Playlist expansion SHALL handle pagination, retries, duplicates and provider quotas while publishing owner-scoped child resources through the normal version/audit/sync lifecycle. Replaying an expansion SHALL not duplicate children or overwrite user edits.

#### Scenario: Quota exhausted between pages

- **WHEN** a playlist job stops after partially importing a playlist
- **THEN** its progress remains recoverable and retry adds only missing children visible to the mobile client
