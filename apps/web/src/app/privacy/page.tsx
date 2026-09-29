export default function Privacy() {
  return (
    <main className="document">
      <p className="eyebrow">DEVELOPMENT DRAFT · NOT A LAUNCH NOTICE</p>
      <h1>Your data deserves care.</h1>
      <p>
        This preview is for local development with synthetic test data. It is not open for public
        registration.
      </p>
      <h2>What this development slice stores</h2>
      <p>
        Account details, password hashes, sessions, notes, tasks, and inbox captures are stored in
        the configured PostgreSQL database. The mobile app also stores an account-scoped cache and
        unsent changes on the device. Session credentials use the operating system’s secure storage.
      </p>
      <h2>Processing</h2>
      <p>
        The server can read stored content; this is not end-to-end encryption. This slice does not
        call AI providers or collect product analytics. Application request logs exclude content and
        credentials.
      </p>
      <h2>Before a public launch</h2>
      <p>
        The final notice must identify the operator and grievance contact, processors, retention
        periods, consent choices, export and deletion procedures. Those features and the legal
        review remain launch requirements.
      </p>
    </main>
  );
}
