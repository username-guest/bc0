import Link from 'next/link';

/** Platform home (apex domain). Tenant storefronts live on their own hosts or at /t/:slug. */
export default function PlatformHome() {
  return (
    <main className="platform">
      <h1>BrandCanvas</h1>
      <p>White-label logo mockups and estimated pricing for promotional-products distributors.</p>
      <p>
        <Link href="/t/demo">Open the demo storefront</Link>
      </p>
    </main>
  );
}
