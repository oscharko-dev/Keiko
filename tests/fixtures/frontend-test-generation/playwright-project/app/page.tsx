// A Next.js-style application entry point (a route `page` file). The detector recognises this as an
// application entry point, so a Playwright browser smoke is the appropriate style for this target.
export default function HomePage(): JSX.Element {
  return (
    <main>
      <h1>Welcome</h1>
      <a href="/dashboard">Go to dashboard</a>
    </main>
  );
}
