## Purpose

Provide complete account access and recovery across mobile and the web shell, with enforceable identity assurance and user-controlled sessions.

## ADDED Requirements

### Requirement: Authentication journeys complete on supported platforms

The system SHALL support email/password, Google and iOS Apple sign-in, verified app links and a web fallback for email verification and recovery. Callback state and return targets SHALL be validated, and tokens SHALL NOT appear in logs or unrelated URLs.

#### Scenario: Email link without the app

- **WHEN** a user opens a verification or recovery link without the app installed
- **THEN** the web shell provides a usable, accessible completion path with a safe return destination

#### Scenario: Tampered OAuth callback

- **WHEN** callback state or its destination does not match the initiated sign-in
- **THEN** no session is issued and the user can safely restart authentication

### Requirement: Password recovery invalidates stolen access

Reset tokens SHALL be hashed at rest, single-use and valid for at most 30 minutes. Completing a reset SHALL revoke existing sessions. Passwords SHALL meet the specified minimum length and breach checks; signup and recovery responses SHALL resist account enumeration and abuse.

#### Scenario: Reused reset token

- **WHEN** a successful reset token is presented again
- **THEN** the reset is refused and previously issued sessions remain revoked

#### Scenario: Expired link

- **WHEN** a user follows an expired recovery link
- **THEN** no password changes and the UI offers a new request without disclosing whether an account exists

### Requirement: Mobile refresh tokens rotate with reuse detection

Mobile access tokens SHALL last at most 15 minutes. Refresh credentials SHALL rotate with 30-day sliding and 90-day absolute lifetimes, remain in secure device storage, and revoke their family on reuse of a rotated credential. Web sessions SHALL use secure httpOnly cookies and CSRF protection.

#### Scenario: Refresh credential reused

- **WHEN** a rotated-out refresh credential is presented
- **THEN** its family is revoked and affected clients must sign in again

#### Scenario: Offline credential expiry

- **WHEN** an offline device's credentials expire
- **THEN** its account-scoped unsynced work is preserved and retry waits for renewed authentication

### Requirement: Sensitive operations require identity assurance

AI and export SHALL require verified email. Export, account deletion, email/password changes, disabling app lock and removing sign-in methods SHALL require authentication within the preceding 10 minutes. Enforcement SHALL occur server-side, including direct API requests.

#### Scenario: Old session requests export

- **WHEN** an otherwise valid session older than 10 minutes requests export
- **THEN** the server requires reauthentication before creating any export job

#### Scenario: Unverified account requests AI

- **WHEN** an unverified account requests assistant execution
- **THEN** no provider request occurs and the client offers email verification

### Requirement: Users control sessions and consent records

Users SHALL see and revoke their own active sessions/devices and manage supported profile/sign-in settings. Consent decisions SHALL record purpose, notice version and time; optional consent SHALL be withdrawable. Foreign session identifiers SHALL neither disclose nor modify another account.

#### Scenario: Revoke a remote device

- **WHEN** a user revokes an active remote session
- **THEN** that session loses further authenticated access and its notification registration is retired as appropriate

#### Scenario: Foreign session identifier

- **WHEN** a user requests another account's session or consent record
- **THEN** the response does not reveal its existence and no state changes
