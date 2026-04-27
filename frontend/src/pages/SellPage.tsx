import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import {
  Upload,
  CheckCircle,
  AlertCircle,
  Loader2,
  Database,
  DollarSign,
  FileJson,
  User,
  Zap,
  Info,
} from "lucide-react";
import { api } from "../lib/api";
import { formatUSDC, getTypeMeta, DATA_TYPE_META } from "../lib/utils";
import clsx from "clsx";
import { getCatalog, useI18n } from "../i18n";

const PRICE_PRESETS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5];

type Tab = "form" | "preview";

interface FormState {
  name: string;
  description: string;
  type: string;
  pricePerQuery: string;
  sellerWallet: string;
  dataText: string;
}

const INITIAL: FormState = {
  name: "",
  description: "",
  type: "whale-wallets",
  pricePerQuery: "0.05",
  sellerWallet: "",
  dataText: "",
};

const STORAGE_KEY = "hazina_sell_form_draft";

function loadDraft(): FormState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL;
    return { ...INITIAL, ...(JSON.parse(raw) as Partial<FormState>) };
  } catch {
    return INITIAL;
  }
}

function saveDraft(form: FormState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(form));
  } catch {
    // localStorage may be unavailable in certain browser contexts
  }
}

function clearDraft(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export default function SellPage() {
  const { locale, t } = useI18n();
  const catalog = getCatalog(locale);
  const navigate = useNavigate();
  const [form, setForm] = useState<FormState>(loadDraft);
  const [tab, setTab] = useState<Tab>("form");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [jsonError, setJsonError] = useState("");

  // Persist form draft across page reloads
  useEffect(() => {
    saveDraft(form);
  }, [form]);

  const set =
    (key: keyof FormState) =>
    (
      e: React.ChangeEvent<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >,
    ) =>
      setForm((f) => ({ ...f, [key]: e.target.value }));

  const typeMeta = getTypeMeta(form.type);
  const typeLabel = typeMeta.labelKey ? t(typeMeta.labelKey) : typeMeta.label;
  const dataTypes = Object.entries(DATA_TYPE_META).map(([value, meta]) => ({
    value,
    label: meta.labelKey ? t(meta.labelKey) : meta.label,
    color: meta.color,
    bg: meta.bg,
  }));

  const validateJson = (text: string): boolean => {
    if (!text.trim()) return true;
    try {
      JSON.parse(text);
      setJsonError("");
      return true;
    } catch {
      setJsonError(t("sell.messages.invalidJson"));
      return false;
    }
  };

  const handleDataChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setForm((f) => ({ ...f, dataText: e.target.value }));
    validateJson(e.target.value);
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setForm((f) => ({ ...f, dataText: text }));
      validateJson(text);
    };
    reader.readAsText(file);
  };

  const isValidStellarAddress = (addr: string): boolean =>
    /^G[A-Z2-7]{55}$/.test(addr.trim());

  const isValid =
    form.name.trim() &&
    form.description.trim() &&
    form.type &&
    parseFloat(form.pricePerQuery) > 0 &&
    isValidStellarAddress(form.sellerWallet) &&
    form.dataText.trim() &&
    !jsonError;

  const handleSubmitConfirmed = async () => {
    setShowConfirm(false);
    if (!isValid || !validateJson(form.dataText)) return;
    setSubmitting(true);
    setError("");
    try {
      await api.createDataset({
        name: form.name.trim(),
        description: form.description.trim(),
        type: form.type,
        pricePerQuery: parseFloat(form.pricePerQuery),
        sellerWallet: form.sellerWallet.trim(),
        data: JSON.parse(form.dataText),
      });
      clearDraft();
      setSuccess(true);
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : t("sell.messages.createFailed"),
      );
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen pt-28 pb-20 flex items-center justify-center">
        <div className="text-center max-w-md mx-auto px-4">
          <div className="w-20 h-20 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto mb-6 animate-pulse-gold">
            <CheckCircle className="w-10 h-10 text-emerald-400" />
          </div>
          <h2 className="font-display text-3xl font-bold text-foreground mb-3">
            {t("sell.messages.listingLive")}
          </h2>
          <p className="text-foreground-muted font-body mb-2">
            {t("sell.messages.listingLiveBody", { name: form.name })}
          </p>
          <p className="text-sm text-foreground-muted font-body mb-8">
            {t("sell.messages.listingLiveRevenue", {
              price: formatUSDC(Number(form.pricePerQuery), locale),
            })}
          </p>
          <div className="flex gap-3 justify-center">
            <button
              onClick={() => {
                clearDraft();
                setForm(INITIAL);
                setSuccess(false);
              }}
              className="btn-ghost px-6 py-3 text-sm"
            >
              {t("common.actions.listAnother")}
            </button>
            <button
              onClick={() => navigate("/marketplace")}
              className="btn-gold px-6 py-3 text-sm"
            >
              {t("common.actions.viewMarketplace")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen pt-28 pb-20">
      <div className="max-w-4xl mx-auto px-4">
        {/* Header */}
        <div className="mb-10">
          <p className="text-gold text-sm font-body font-medium tracking-widest uppercase mb-2">
            {t("sell.eyebrow")}
          </p>
          <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground mb-3">
            {t("sell.title")}
          </h1>
          <p className="text-foreground-muted font-body text-lg">
            {t("sell.subtitle")}
          </p>
        </div>

        {/* Tab switcher */}
        <div className="flex gap-1 p-1 glass-card inline-flex mb-8 rounded-xl">
          {(["form", "preview"] as Tab[]).map((tabKey) => (
            <button
              key={tabKey}
              onClick={() => setTab(tabKey)}
              className={clsx(
                "px-5 py-2 rounded-lg text-sm font-body font-medium transition-all duration-200 capitalize",
                tab === tabKey
                  ? "bg-gold text-void shadow-sm"
                  : "text-foreground-muted hover:text-foreground",
              )}
            >
              {tabKey === "form" ? t("sell.tabs.form") : t("sell.tabs.preview")}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main form */}
          <div className="lg:col-span-2">
            {tab === "form" ? (
              <div className="glass-card-gold p-6 space-y-6">
                {/* Dataset name */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <Database className="w-4 h-4 text-gold" />
                    {t("sell.form.datasetName")}{" "}
                    <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.name}
                    onChange={set("name")}
                    placeholder={t("sell.form.datasetNamePlaceholder")}
                    className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/50 transition-colors"
                  />
                </div>

                {/* Description */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <FileJson className="w-4 h-4 text-gold" />
                    {t("sell.form.description")}{" "}
                    <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    value={form.description}
                    onChange={set("description")}
                    placeholder={t("sell.form.descriptionPlaceholder")}
                    className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground placeholder:text-muted focus:outline-none focus:border-gold/50 transition-colors resize-none h-24"
                  />
                </div>

                {/* Type + Price row */}
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                      <Zap className="w-4 h-4 text-gold" />
                      {t("sell.form.dataType")}{" "}
                      <span className="text-red-400">*</span>
                    </label>
                    <select
                      value={form.type}
                      onChange={set("type")}
                      className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground focus:outline-none focus:border-gold/50 transition-colors"
                    >
                      {dataTypes.map(({ value, label }) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                      <DollarSign className="w-4 h-4 text-gold" />
                      {t("sell.form.pricePerQuery")}{" "}
                      <span className="text-red-400">*</span>
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      value={form.pricePerQuery}
                      onChange={set("pricePerQuery")}
                      className="w-full bg-void/60 border border-border/60 rounded-xl px-4 py-3 text-sm font-body text-foreground focus:outline-none focus:border-gold/50 transition-colors"
                    />
                  </div>
                </div>

                {/* Price presets */}
                <div>
                  <p className="text-xs text-muted-2 font-body mb-2">
                    {t("sell.form.quickPricePresets")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {PRICE_PRESETS.map((p) => (
                      <button
                        key={p}
                        onClick={() =>
                          setForm((f) => ({ ...f, pricePerQuery: String(p) }))
                        }
                        className={clsx(
                          "px-3 py-1.5 rounded-lg text-xs font-body font-medium border transition-all duration-150",
                          parseFloat(form.pricePerQuery) === p
                            ? "bg-gold text-void border-gold"
                            : "border-border/60 text-foreground-muted hover:border-gold/40 hover:text-gold",
                        )}
                      >
                        ${p}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Stellar wallet */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <User className="w-4 h-4 text-gold" />
                    {t("sell.form.sellerWallet")}{" "}
                    <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.sellerWallet}
                    onChange={set("sellerWallet")}
                    placeholder={t("sell.form.sellerWalletPlaceholder")}
                    className={clsx(
                      "w-full bg-void/60 border rounded-xl px-4 py-3 text-sm font-mono text-foreground placeholder:text-muted focus:outline-none transition-colors",
                      form.sellerWallet && !isValidStellarAddress(form.sellerWallet)
                        ? "border-red-500/50 focus:border-red-500/70"
                        : "border-border/60 focus:border-gold/50",
                    )}
                  />
                  {form.sellerWallet && !isValidStellarAddress(form.sellerWallet) && (
                    <p className="text-xs text-red-400 mt-1 font-body">
                      {t("sell.form.sellerWalletError")}
                    </p>
                  )}
                  <p className="text-xs text-muted-2 font-body mt-1.5 flex items-start gap-1">
                    <Info className="w-3 h-3 mt-0.5 flex-shrink-0" />
                    {t("sell.form.sellerWalletHelp")}
                  </p>
                </div>

                {/* Data upload */}
                <div>
                  <label className="text-sm font-body font-medium text-foreground-muted mb-2 flex items-center gap-2">
                    <Upload className="w-4 h-4 text-gold" />
                    {t("sell.form.datasetJson")}{" "}
                    <span className="text-red-400">*</span>
                  </label>

                  {/* File upload */}
                  <label className="flex items-center gap-3 cursor-pointer p-3 rounded-xl border border-dashed border-border-gold/30 hover:border-border-gold/60 bg-gold/5 hover:bg-gold/8 transition-all duration-200 mb-3 group">
                    <Upload className="w-5 h-5 text-gold group-hover:scale-110 transition-transform" />
                    <div>
                      <p className="text-sm font-body font-medium text-foreground">
                        {t("sell.form.uploadFileTitle")}
                      </p>
                      <p className="text-xs text-muted-2 font-body">
                        {t("sell.form.uploadFileSubtitle")}
                      </p>
                    </div>
                    <input
                      type="file"
                      accept=".json,.csv"
                      className="hidden"
                      onChange={handleFileUpload}
                    />
                  </label>

                  <textarea
                    value={form.dataText}
                    onChange={handleDataChange}
                    placeholder={t("sell.form.dataPlaceholder")}
                    className={clsx(
                      "w-full bg-void/60 border rounded-xl px-4 py-3 text-xs font-mono text-foreground placeholder:text-muted focus:outline-none transition-colors resize-none h-48",
                      jsonError
                        ? "border-red-500/50 focus:border-red-500/70"
                        : "border-border/60 focus:border-gold/50",
                    )}
                  />
                  {jsonError && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                      <p className="text-xs text-red-400 font-body">
                        {jsonError}
                      </p>
                    </div>
                  )}
                  {form.dataText && !jsonError && (
                    <div className="flex items-center gap-1.5 mt-1.5">
                      <CheckCircle className="w-3.5 h-3.5 text-emerald-400" />
                      <p className="text-xs text-emerald-400 font-body">
                        {t("common.states.validJson")}
                      </p>
                    </div>
                  )}
                </div>

                {error && (
                  <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/5 border border-red-500/20">
                    <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                    <p className="text-sm text-red-400 font-body">{error}</p>
                  </div>
                )}

                <button
                  onClick={() => setShowConfirm(true)}
                  disabled={!isValid || submitting}
                  className={clsx(
                    "btn-gold w-full flex items-center justify-center gap-2 py-4 text-base",
                    (!isValid || submitting) && "opacity-50 cursor-not-allowed",
                  )}
                >
                  {submitting ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      {t("sell.messages.publishing")}
                    </>
                  ) : (
                    <>
                      <Upload className="w-5 h-5" />
                      {t("sell.form.submit")}
                    </>
                  )}
                </button>

                {/* Confirmation dialog */}
                {showConfirm && (
                  <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
                    <div
                      className="absolute inset-0 bg-void/80 backdrop-blur-sm"
                      onClick={() => setShowConfirm(false)}
                      aria-hidden="true"
                    />
                    <div
                      role="dialog"
                      aria-modal="true"
                      aria-labelledby="confirm-title"
                      className="relative w-full max-w-sm glass-card-gold p-6 rounded-2xl"
                    >
                      <h3
                        id="confirm-title"
                        className="font-display font-bold text-lg text-foreground mb-2"
                      >
                        Publish dataset?
                      </h3>
                      <p className="text-sm text-foreground-muted font-body mb-6">
                        You are about to list{" "}
                        <span className="text-foreground font-medium">
                          {form.name}
                        </span>{" "}
                        at{" "}
                        <span className="text-gold font-semibold">
                          ${formatUSDC(Number(form.pricePerQuery), locale)} USDC
                        </span>{" "}
                        per query. This action cannot be undone.
                      </p>
                      <div className="flex gap-3">
                        <button
                          onClick={() => setShowConfirm(false)}
                          className="btn-ghost flex-1 py-2.5 text-sm"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={handleSubmitConfirmed}
                          className="btn-gold flex-1 py-2.5 text-sm"
                        >
                          Publish
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              /* Preview tab */
              <div>
                <p className="text-sm text-foreground-muted font-body mb-4">
                  {t("sell.preview.intro")}
                </p>
                <div className="glass-card-gold p-6">
                  <div className="flex justify-between items-start mb-4">
                    <span
                      className={clsx(
                        "type-badge",
                        typeMeta.color,
                        typeMeta.bg,
                      )}
                    >
                      <Zap className="w-3 h-3" />
                      {typeLabel}
                    </span>
                    <div className="text-right">
                      <p className="text-xs text-muted-2 mb-0.5">
                        {t("common.units.perQuery")}
                      </p>
                      <p className="font-display font-bold text-xl text-gold">
                        ${formatUSDC(Number(form.pricePerQuery || "0"), locale)}
                      </p>
                    </div>
                  </div>
                  <h3 className="font-display font-semibold text-foreground text-lg mb-2">
                    {form.name || t("sell.preview.datasetNameFallback")}
                  </h3>
                  <p className="text-sm text-foreground-muted font-body leading-relaxed mb-5">
                    {form.description ||
                      t("sell.preview.descriptionFallback")}
                  </p>
                  <div className="flex items-center gap-4 mb-5 text-xs text-foreground-muted font-body">
                    <span>0 {t("common.units.queriesServed")}</span>
                    <span className="w-px h-3 bg-border" />
                    <span className="font-mono">
                      {form.sellerWallet
                        ? `${form.sellerWallet.slice(0, 6)}...${form.sellerWallet.slice(-6)}`
                        : t("sell.preview.walletFallback")}
                    </span>
                  </div>
                  <div className="w-full py-3 rounded-xl border border-border-gold/30 text-gold text-sm font-body font-semibold text-center">
                    {t("sell.preview.buyLabel", {
                      price: formatUSDC(Number(form.pricePerQuery || "0"), locale),
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-4">
            {/* Earnings calculator */}
            <div className="glass-card p-5">
              <h3 className="font-display font-semibold text-foreground text-base mb-4">
                {t("sell.earnings.title")}
              </h3>
              {[
                { queries: 10, label: t("sell.earnings.tenQueries") },
                { queries: 100, label: t("sell.earnings.hundredQueries") },
                { queries: 1000, label: t("sell.earnings.thousandQueries") },
              ].map(({ queries, label }) => {
                const price = parseFloat(form.pricePerQuery) || 0;
                const earned = (price * queries * 0.95).toFixed(2);
                return (
                  <div
                    key={queries}
                    className="flex justify-between items-center py-2 border-b border-border/30 last:border-0"
                  >
                    <span className="text-sm text-foreground-muted font-body">
                      {label}
                    </span>
                    <span className="font-body font-semibold text-gold text-sm">
                      ${formatUSDC(Number(earned), locale)}
                    </span>
                  </div>
                );
              })}
              <p className="text-xs text-muted-2 font-body mt-3">
                {t("sell.earnings.footnote")}
              </p>
            </div>

            {/* Tips */}
            <div className="glass-card p-5">
              <h3 className="font-display font-semibold text-foreground text-base mb-3">
                {t("sell.tips.title")}
              </h3>
              <ul className="space-y-2">
                {catalog.sell.tips.items.map((tip, i) => (
                  <li
                    key={i}
                    className="text-xs text-foreground-muted font-body flex gap-2"
                  >
                    <span className="text-gold flex-shrink-0">✦</span>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>

            {/* How it works */}
            <div className="glass-card p-5 bg-gold/5 border-border-gold/20">
              <h3 className="font-display font-semibold text-gold text-sm mb-3">
                {t("sell.howItWorks.title")}
              </h3>
              <div className="space-y-2 text-xs text-foreground-muted font-body">
                {catalog.sell.howItWorks.items.map((item, index) => (
                  <p key={item}>
                    {index + 1}. {item}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
