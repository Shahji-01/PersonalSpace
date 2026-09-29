import Link from 'next/link';

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="hero-copy">
          <p className="eyebrow">
            <span /> LIFE, WITH A LITTLE MORE ROOM
          </p>
          <h1>
            Less scattered.
            <br />
            More <em>you.</em>
          </h1>
          <p className="intro">
            A thought on the way home. A thing to do tomorrow. Give it a place, and give yourself a
            clearer day.
          </p>
          <div className="release-note">
            <span className="tiny-mark" aria-hidden>
              ↗
            </span>
            <div>
              <strong>Your space is taking shape.</strong>
              <p>
                We’re building PersonalSpace for Android and iOS. The first development slice brings
                capture, notes, and tasks together.
              </p>
            </div>
          </div>
          <Link className="text-link" href="#inside">
            A look inside <span aria-hidden>↓</span>
          </Link>
        </div>
        <div className="scene" aria-label="Illustration of the planned PersonalSpace experience">
          <span className="orbit orbit-one" />
          <span className="orbit orbit-two" />
          <div className="paper paper-back" />
          <div className="paper">
            <div className="paper-top">
              <span className="brand-icon">p.</span>
              <span>A MOMENT TO RESET</span>
              <span>✳</span>
            </div>
            <h2>A little headspace.</h2>
            <p>One small step at a time.</p>
            <div className="paper-task">
              <span className="checkbox checked">✓</span>
              <span>Get the idea out of your head</span>
            </div>
            <div className="paper-task">
              <span className="checkbox" />
              <span>Make time for what matters</span>
            </div>
            <div className="paper-task">
              <span className="checkbox" />
              <span>Leave a little room for yourself</span>
            </div>
            <div className="paper-note">
              <span>JUST A THOUGHT</span>
              <p>
                You don’t have to organize your whole life.
                <br />
                Start with one thing.
              </p>
            </div>
            <div className="paper-bottom">
              <span>YOUR PACE. YOUR SPACE.</span>
              <span>＋</span>
            </div>
          </div>
          <div className="floating-note">
            <span aria-hidden>✦</span> Save now. Sort later.
          </div>
          <p className="illustration-label">PRODUCT CONCEPT · NOT A LIVE ACCOUNT</p>
        </div>
      </section>
      <section className="inside" id="inside">
        <div>
          <p className="eyebrow">SMALL MOMENTS, CONNECTED</p>
          <h2>
            A home for the things
            <br />
            you want to come back to.
          </h2>
        </div>
        <div className="features">
          <article>
            <span className="feature-number">01 / CAPTURE</span>
            <h3>Catch the thought.</h3>
            <p>
              Save an idea without deciding where it belongs. Your inbox keeps it ready for later.
            </p>
          </article>
          <article>
            <span className="feature-number">02 / FOCUS</span>
            <h3>Find your next step.</h3>
            <p>Bring today’s tasks into one calm view. Finish something. Make a little progress.</p>
          </article>
          <article>
            <span className="feature-number">03 / KEEP</span>
            <h3>Make it yours.</h3>
            <p>Turn a capture into a note or a task. Keep the connection to where it started.</p>
          </article>
        </div>
      </section>
      <section className="trust">
        <span aria-hidden>◎</span>
        <div>
          <h2>Built around your own space.</h2>
          <p>
            Account isolation and reliable saving come first. Learning, money, reminders, and
            optional AI are planned for later milestones.
          </p>
        </div>
        <Link className="text-link" href="/privacy">
          Read the privacy draft ↗
        </Link>
      </section>
    </main>
  );
}
