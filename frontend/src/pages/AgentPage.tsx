import { useState } from 'react';
import {
  Bot,
  Search,
  Loader2,
  TrendingUp,
  AlertTriangle,
  CheckCircle,
  Zap,
  DollarSign,
  ShieldCheck,
  Activity,
} from 'lucide-react';
import { api, AgentJob } from '../lib/api';
import { AgentResultSkeleton } from '../components/ui/SkeletonLoader';
import clsx from 'clsx';
import { getCatalog, useI18n } from '../i18n';

const RISK_COLOR: Record<string, string> = {
  Low: 'text-emerald-400',
  Medium: 'text-amber-400',
  High: 'text-red-400',
};

const SENTIMENT_COLOR: Record<string, string> = {
  Bullish: 'text-emerald-400',
  Neutral: 'text-foreground-muted',
  Bearish: 'text-red-400',
};

const CONFIDENCE_COLOR: Record<string, string> = {
  High: 'text-emerald-400',
  Medium: 'text-amber-400',
  Low: 'text-red-400',
  Neutral: 'text-foreground-muted',
};

export default function AgentPage() {
  const { locale, t } = useI18n();
  const catalog = getCatalog(locale);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AgentJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAgent() {
    if (!query.trim() || query.trim().length < 5) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const job = await api.agentDemo(query.trim());
      setResult(job);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("common.states.error"));
    } finally {
      setLoading(false);
    }
  }

  const localizeScale = (value: string) => {
    const normalized = value.toLowerCase();
    if (normalized === "low") return t("agent.scales.low");
    if (normalized === "medium") return t("agent.scales.medium");
    if (normalized === "high") return t("agent.scales.high");
    if (normalized === "neutral") return t("agent.scales.neutral");
    if (normalized === "bullish") return t("agent.scales.bullish");
    if (normalized === "bearish") return t("agent.scales.bearish");
    return value;
  };

  return (
    <div className="min-h-screen pt-28 pb-20">
      <div className="max-w-4xl mx-auto px-4">

        {/* Header */}
        <div className="mb-10">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-xl bg-gold/10 border border-gold/30 flex items-center justify-center">
              <Bot className="w-5 h-5 text-gold" />
            </div>
            <p className="text-gold text-sm font-body font-medium tracking-widest uppercase">{t("agent.eyebrow")}</p>
          </div>
          <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-3">
            {t("agent.title")}
          </h1>
          <p className="text-foreground-muted font-body text-lg">
            {t("agent.subtitle")}
          </p>
        </div>

        {/* How it works strip */}
        <div className="glass-card p-5 mb-8 grid grid-cols-2 md:grid-cols-4 gap-4">
          {[
            { icon: DollarSign, label: t("agent.strip.youPay"), value: '1 USDC' },
            { icon: Activity, label: t("agent.strip.datasetsQueried"), value: t("agent.strip.sellersValue") },
            { icon: Zap, label: t("agent.strip.agentSpends"), value: '0.14 USDC' },
            { icon: ShieldCheck, label: t("agent.strip.protocol"), value: 'Stellar x402' },
          ].map(({ icon: Icon, label, value }) => (
            <div key={label} className="flex flex-col items-center text-center gap-1">
              <Icon className="w-4 h-4 text-gold mb-1" />
              <p className="text-xs font-body text-foreground-muted">{label}</p>
              <p className="text-sm font-body font-semibold text-foreground">{value}</p>
            </div>
          ))}
        </div>

        {/* Query input */}
        <div className="glass-card-gold p-6 mb-6">
          <label className="block text-sm font-body font-medium text-foreground mb-3">
            {t("agent.inputLabel")}
          </label>
          <div className="relative">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && runAgent()}
              placeholder={t("agent.inputPlaceholder")}
              className="w-full bg-void/60 border border-border/60 rounded-xl pl-11 pr-4 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/40 transition-colors"
            />
          </div>

          {/* Example queries */}
          <div className="flex flex-wrap gap-2 mt-3">
            {catalog.agent.exampleQueries.map((q) => (
              <button
                key={q}
                onClick={() => setQuery(q)}
                className="px-3 py-1.5 rounded-lg text-xs font-body bg-surface-2 text-foreground-muted hover:text-gold hover:bg-gold/10 transition-all duration-200"
              >
                {q}
              </button>
            ))}
          </div>

          <div className="flex items-center justify-between mt-5">
            <p className="text-xs font-body text-foreground-muted">
              {t("agent.demoModeNote")}
            </p>
            <button
              onClick={runAgent}
              disabled={loading || query.trim().length < 5}
              className={clsx(
                'btn-gold px-6 py-2.5 text-sm flex items-center gap-2 transition-all duration-200',
                (loading || query.trim().length < 5) && 'opacity-50 cursor-not-allowed'
              )}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t("agent.loading")}
                </>
              ) : (
                <>
                  <Bot className="w-4 h-4" />
                  {t("common.actions.runAgent")}
                </>
              )}
            </button>
          </div>
        </div>

        {/* Loading skeleton */}
        {loading && <AgentResultSkeleton />}

        {/* Error with retry */}
        {error && (
          <div className="glass-card border border-red-500/30 p-5 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <p className="font-body font-medium text-red-400 text-sm mb-1">
                {t("agent.errorTitle")}
              </p>
              <p className="font-body text-foreground-muted text-sm mb-3">{error}</p>
              <button
                type="button"
                onClick={() => void runAgent()}
                disabled={loading || !query.trim() || query.trim().length < 5}
                className="btn-ghost text-xs px-4 py-2 flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Retry the last agent request"
              >
                <svg
                  className="w-3.5 h-3.5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <path
                    fillRule="evenodd"
                    d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                    clipRule="evenodd"
                  />
                </svg>
	                {t("common.actions.retry")}
	              </button>
            </div>
          </div>
        )}

        {/* Result */}
        {result && !loading && (
          <div className="space-y-4">
            {/* Top opportunity */}
            <div className="glass-card-gold p-6">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp className="w-5 h-5 text-gold" />
                <h2 className="font-display text-lg font-semibold text-foreground">{t("agent.result.topOpportunity")}</h2>
                {result.demo && (
                  <span className="ml-auto px-2 py-0.5 rounded-full text-xs font-body bg-gold/10 text-gold border border-gold/20">
                    {t("common.states.demo")}
                  </span>
                )}
              </div>

              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-5">
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">{t("common.labels.protocol")}</p>
                  <p className="font-display font-semibold text-foreground">{result.report.topOpportunity.protocol}</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">{t("agent.metrics.vaultPool")}</p>
                  <p className="font-body font-medium text-foreground text-sm">{result.report.topOpportunity.vault}</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">{t("common.labels.chain")}</p>
                  <p className="font-body font-medium text-foreground text-sm">{result.report.topOpportunity.chain}</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">{t("common.labels.apy")}</p>
                  <p className="font-display font-bold text-gold text-xl">{result.report.topOpportunity.apy}%</p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">{t("common.labels.riskLevel")}</p>
                  <p className={clsx('font-body font-semibold text-sm', RISK_COLOR[result.report.topOpportunity.riskLevel] ?? 'text-foreground')}>
                    {localizeScale(result.report.topOpportunity.riskLevel)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-foreground-muted font-body mb-1">{t("common.labels.whaleConfidence")}</p>
                  <p className={clsx('font-body font-semibold text-sm', CONFIDENCE_COLOR[result.report.topOpportunity.whaleConfidence] ?? 'text-foreground')}>
                    {localizeScale(result.report.topOpportunity.whaleConfidence)}
                  </p>
                </div>
              </div>

              <div className="border-t border-border/40 pt-4">
                <p className="text-xs text-foreground-muted font-body mb-2">{t("common.labels.sentiment")}</p>
                <span className={clsx('text-sm font-body font-semibold', SENTIMENT_COLOR[result.report.topOpportunity.sentimentScore] ?? 'text-foreground')}>
                  {localizeScale(result.report.topOpportunity.sentimentScore)}
                </span>
              </div>
            </div>

            {/* Reasoning */}
            <div className="glass-card p-6">
              <h3 className="font-display font-semibold text-foreground mb-3">{t("agent.result.reasoning")}</h3>
              <p className="font-body text-foreground-muted text-sm leading-relaxed">{result.report.reasoning}</p>
            </div>

            {/* Alternatives + Warnings */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="glass-card p-5">
                <h3 className="font-display font-semibold text-foreground mb-3 flex items-center gap-2">
                  <CheckCircle className="w-4 h-4 text-emerald-400" />
                  {t("agent.result.alternatives")}
                </h3>
                {result.report.alternatives.length === 0 ? (
                  <p className="text-xs font-body text-foreground-muted">{t("agent.result.noAlternatives")}</p>
                ) : (
                  <ul className="space-y-2">
                    {result.report.alternatives.map((alt, i) => (
                      <li key={i} className="text-sm font-body text-foreground-muted leading-relaxed flex gap-2">
                        <span className="text-gold font-semibold flex-shrink-0">{i + 1}.</span>
                        {alt}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="glass-card p-5">
                <h3 className="font-display font-semibold text-foreground mb-3 flex items-center gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-400" />
                  {t("agent.result.warnings")}
                </h3>
                {result.report.warnings.length === 0 ? (
                  <p className="text-sm font-body text-emerald-400">{t("agent.result.noWarnings")}</p>
                ) : (
                  <ul className="space-y-2">
                    {result.report.warnings.map((w, i) => (
                      <li key={i} className="text-sm font-body text-amber-300 leading-relaxed flex gap-2">
                        <span className="flex-shrink-0">•</span>
                        {w}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Raw analysis */}
            <div className="glass-card p-6">
              <h3 className="font-display font-semibold text-foreground mb-3">{t("agent.result.fullAnalysis")}</h3>
              <p className="font-body text-foreground-muted text-sm leading-relaxed">{result.report.rawAnalysis}</p>
            </div>

            {/* Payment trail */}
            <div className="glass-card p-6">
              <div className="flex items-center gap-2 mb-4">
                <DollarSign className="w-5 h-5 text-gold" />
                <h3 className="font-display font-semibold text-foreground">{t("agent.result.paymentTrail")}</h3>
                <span className="ml-auto px-2 py-0.5 rounded-full text-xs font-body bg-amber-400/10 text-amber-400 border border-amber-400/20">
                  x402 Protocol
                </span>
              </div>

              <div className="space-y-3 mb-4">
                {result.payments.sellerPayments.map((p) => {
                  const typeColors: Record<string, string> = {
                    'yield-data': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
                    'whale-wallets': 'bg-blue-500/10 text-blue-400 border-blue-500/20',
                    'risk-scores': 'bg-red-500/10 text-red-400 border-red-500/20',
                    'sentiment': 'bg-purple-500/10 text-purple-400 border-purple-500/20',
                  };
                  const badgeClass = typeColors[p.type] || 'bg-surface-2 text-foreground-muted border-border';
                  return (
                    <div key={p.txHash} className="flex items-center gap-3 p-3 rounded-xl bg-surface-2/40 border border-border/30">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={clsx('px-2 py-0.5 rounded-md text-[10px] font-body font-semibold border', badgeClass)}>
                            {p.type === "whale-wallets"
                              ? t("dataTypes.whaleWallets")
                              : p.type === "yield-data"
                                ? t("dataTypes.yieldData")
                                : p.type === "risk-scores"
                                  ? t("dataTypes.riskScores")
                                  : p.type === "sentiment"
                                    ? t("dataTypes.sentiment")
                                    : p.type}
                          </span>
                          {!p.onChain && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] font-body bg-amber-400/10 text-amber-400">{t("common.labels.simulated")}</span>
                          )}
                        </div>
                        <p className="text-sm font-body text-foreground truncate">{p.seller}</p>
                        <p className="text-[10px] font-mono text-muted truncate">{p.txHash}</p>
                      </div>
                      <p className="text-sm font-display font-bold text-gold flex-shrink-0">{p.amount} USDC</p>
                    </div>
                  );
                })}
              </div>

              {/* Totals */}
              <div className="border-t border-border/40 pt-3 space-y-2">
                <div className="flex items-center justify-between text-sm font-body">
                  <span className="text-foreground-muted">{t("agent.result.totalSpent")}</span>
                  <span className="text-foreground font-medium">{result.payments.totalSpent} USDC</span>
                </div>
                <div className="flex items-center justify-between text-sm font-body">
                  <span className="text-foreground-muted">{t("agent.result.agentProfit")}</span>
                  <span className="text-gold font-semibold">{result.payments.agentProfit} USDC</span>
                </div>
                <div className="flex items-center justify-between text-sm font-body">
                  <span className="text-foreground-muted">{t("agent.result.youPaid")}</span>
                  <span className="text-foreground font-bold">{result.payments.humanPaid} {result.payments.currency}</span>
                </div>
              </div>

              {result.payments.note && (
                <div className="flex items-center gap-2 mt-3 p-2.5 rounded-lg bg-amber-400/5 border border-amber-400/15">
                  <ShieldCheck className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                  <p className="text-xs font-body text-amber-400">{result.payments.note}</p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
