import { Link } from "react-router-dom";

export default function TermsPage() {
  return (
    <div className="min-h-screen pt-28 pb-20">
      <div className="max-w-4xl mx-auto px-4">
        <div className="glass-card p-8 space-y-6">
          <div className="space-y-3">
            <p className="text-sm font-medium uppercase tracking-[0.3em] text-gold">
              Terms of Service
            </p>
            <h1 className="font-display text-4xl font-bold text-foreground">
              Hazina Testnet Terms of Service
            </h1>
            <p className="text-sm text-foreground-muted font-body">
              This is a testnet application. Do not use real funds.
            </p>
          </div>

          <section className="space-y-3">
            <h2 className="font-semibold text-2xl text-foreground">Service description</h2>
            <p className="text-foreground-muted font-body leading-7">
              Hazina provides an escrow marketplace for dataset sales and research queries on a test network. The platform is intended for experimentation, discovery, and data exchange using testnet assets only.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-semibold text-2xl text-foreground">User responsibilities</h2>
            <ul className="list-disc list-inside text-foreground-muted font-body leading-7 space-y-2">
              <li>Do not deposit or transfer real funds through this application.</li>
              <li>Verify every counterparty and dataset before engaging in transactions.</li>
              <li>Keep your wallet credentials secure and only use testnet accounts for all activity.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="font-semibold text-2xl text-foreground">Limitation of liability</h2>
            <p className="text-foreground-muted font-body leading-7">
              Hazina is provided "as is" without warranties of any kind. The platform operator is not liable for lost testnet assets, data disputes, or any damages arising from the use of this service.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="font-semibold text-2xl text-foreground">Testnet disclaimer</h2>
            <div className="rounded-3xl border border-gold/20 bg-gold/10 p-5 text-foreground">
              <p className="font-semibold text-lg text-gold">Important:</p>
              <p className="mt-2 text-foreground-muted font-body leading-7">
                This is a testnet application. Do not use real funds. All transactions and balances on Hazina are for demonstration and development purposes only.
              </p>
            </div>
          </section>

          <div className="pt-4 border-t border-surface-2/60">
            <Link to="/" className="btn-gold px-5 py-2.5 text-sm">
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
