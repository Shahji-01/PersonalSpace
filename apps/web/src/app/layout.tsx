import type { Metadata } from 'next';
import Link from 'next/link';
import './styles.css';

export const metadata: Metadata = {
  title: 'PersonalSpace — A clearer day',
  description: 'A personal space for your thoughts, plans, learning, and money. In development.',
  robots: { index: false, follow: false },
};
export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en-IN">
      <body>
        <header className="site-header">
          <Link className="wordmark" href="/">
            <span className="brand-icon" aria-hidden>
              p.
            </span>{' '}
            PersonalSpace
          </Link>
          <span className="preview">IN DEVELOPMENT</span>
        </header>
        {children}
        <footer>
          <Link href="/">PersonalSpace</Link>
          <span>A little space for everything that matters.</span>
          <nav aria-label="Legal">
            <Link href="/privacy">Privacy draft</Link>
            <Link href="/terms">Terms draft</Link>
          </nav>
        </footer>
      </body>
    </html>
  );
}
