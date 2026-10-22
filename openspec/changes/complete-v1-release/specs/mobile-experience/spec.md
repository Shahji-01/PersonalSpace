## Purpose

Provide consistent, accessible mobile workflows whose appearance, regional behavior and privacy controls match the user's saved preferences.

## ADDED Requirements

### Requirement: Saved preferences govern actual behavior

Theme, text size, timezone/locale, week start, day-part times, working/study hours, base currency, money defaults, capture destination, notification settings and analytics consent SHALL affect their relevant workflows. Defaults SHALL follow the product specification and account switching SHALL replace the active preference set.

#### Scenario: Theme changed to dark

- **WHEN** a user selects dark appearance and reopens the app
- **THEN** screens, dialogs and the editor use the selected appearance with readable contrast

#### Scenario: Capture default changed

- **WHEN** a user changes the default capture destination
- **THEN** the next ordinary capture opens with that destination while explicit native shortcuts retain their requested type

### Requirement: App lock protects all entry points

Biometric/PIN app lock, timeout and switcher privacy SHALL protect app content after backgrounding and through notification/share/deep-link entry points. Disabling lock SHALL require recent authentication; biometric cancellation SHALL not expose content or discard pending work.

#### Scenario: Notification opens a locked app

- **WHEN** a notification is tapped after the app-lock timeout
- **THEN** private content remains hidden until successful unlock and navigation resumes afterward

#### Scenario: Biometrics unavailable

- **WHEN** biometric authentication becomes unavailable
- **THEN** the configured secure fallback/recovery is offered without bypassing lock or losing local drafts

### Requirement: Core flows expose consistent accessible states

Navigation and forms SHALL provide labeled controls, focus restoration, adequate touch targets, contrast, text scaling and screen-reader support. Lists/forms SHALL expose useful empty, loading, offline, pending, conflict and failure states without raw internal errors, and prevent duplicate submissions.

#### Scenario: Save fails while using a screen reader

- **WHEN** a form save fails
- **THEN** the error is announced, entered values remain available and focus permits correction or retry

#### Scenario: Large text and keyboard

- **WHEN** maximum supported text scaling and the keyboard are active on a small supported screen
- **THEN** primary actions and validation messages remain reachable without clipping essential content

### Requirement: Localization preserves data meaning

User-facing strings SHALL be externalized for the specified launch locales and dates, numbers and currencies SHALL use the active locale without changing stored values. Parsing SHALL preserve unambiguous integer amounts and timezone semantics; missing translations SHALL have a readable fallback.

#### Scenario: Locale changed after saving an amount

- **WHEN** a user changes locale
- **THEN** the amount displays in the new format while its stored minor-unit value and currency remain unchanged
