import { Link, useLocation } from "react-router-dom";
import {
  Database,
  BarChart3,
  Upload,
  ShoppingCart,
  Menu,
  X,
  Bot,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import clsx from "clsx";
import { LocaleSwitcher, useI18n } from "../../i18n";

const NAV_LINKS = [
  { to: "/marketplace", key: "nav.marketplace", icon: ShoppingCart, dataTour: "marketplace-link" },
  { to: "/agent", key: "nav.agent", icon: Bot, dataTour: "agent-link" },
  { to: "/sell", key: "nav.sell", icon: Upload, dataTour: "sell-link" },
  { to: "/dashboard", key: "nav.dashboard", icon: BarChart3, dataTour: "dashboard-link" },
] as const;

export default function Navbar() {
  const { pathname } = useLocation();
  const [mobileOpen, setMobileOpen] = useState(false);
  const { t } = useI18n();
  const mobileMenuId = useId();

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    document.body.style.overflow = mobileOpen ? "hidden" : "";

    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  return (
    <header className="fixed top-0 left-0 right-0 z-50">
      <div className="mx-3 mt-3 sm:mx-4 sm:mt-4">
        <nav className="glass-card-gold px-4 py-3 sm:px-5 sm:py-4 xl:px-6 flex items-center justify-between gap-3">
          {/* Logo */}
          <Link
            to="/"
            className="flex min-w-0 items-center gap-3 group"
            aria-label="Hazina Home"
          >
            <div className="w-9 h-9 rounded-xl bg-gold/10 border border-gold/30 flex items-center justify-center group-hover:border-gold/60 transition-all duration-300 shrink-0">
              <Database className="w-5 h-5 text-gold" aria-hidden="true" />
            </div>
            <span className="font-display font-semibold text-lg sm:text-xl text-foreground group-hover:text-gold transition-colors duration-300 truncate">
              {t("nav.brand")}
            </span>
          </Link>

          {/* Desktop nav */}
          <div className="hidden xl:flex items-center gap-1.5 flex-nowrap">
            {NAV_LINKS.map(({ to, key, icon: Icon, dataTour }) => (
              <Link
                key={to}
                to={to}
                data-tour={dataTour}
                className={clsx(
                  "flex shrink-0 items-center gap-2 whitespace-nowrap px-3 py-2 rounded-xl text-sm font-medium font-body transition-all duration-200",
                  pathname === to
                    ? "bg-gold/15 text-gold border border-gold/25"
                    : "text-foreground-muted hover:text-foreground hover:bg-surface-2",
                )}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
                {t(key)}
              </Link>
            ))}
          </div>

          {/* CTA */}
          <div className="hidden xl:flex items-center gap-3 shrink-0">
            <LocaleSwitcher />
            <Link
              to="/marketplace"
              className="btn-gold text-sm px-4 py-2 whitespace-nowrap"
            >
              {t("common.actions.browseData")}
            </Link>
          </div>

          {/* Mobile toggle */}
          <button
            type="button"
            className="xl:hidden flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-gold/15 bg-surface/70 text-foreground-muted hover:text-foreground hover:border-gold/30 transition-colors"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-expanded={mobileOpen}
            aria-controls={mobileMenuId}
            aria-label={t("nav.mobileMenu")}
          >
            {mobileOpen ? (
              <X className="w-5 h-5" aria-hidden="true" />
            ) : (
              <Menu className="w-5 h-5" aria-hidden="true" />
            )}
          </button>
        </nav>

        {/* Mobile menu */}
        <div
          className={clsx(
            "xl:hidden fixed inset-0 z-40 transition-all duration-300",
            mobileOpen ? "pointer-events-auto" : "pointer-events-none",
          )}
          aria-hidden={!mobileOpen}
        >
          <button
            type="button"
            className={clsx(
              "absolute inset-0 bg-void/72 backdrop-blur-sm transition-opacity duration-300",
              mobileOpen ? "opacity-100" : "opacity-0",
            )}
            onClick={() => setMobileOpen(false)}
            aria-label={t("nav.mobileMenu")}
          />
          <div
            id={mobileMenuId}
            className={clsx(
              "absolute right-3 top-20 bottom-3 left-3 sm:left-auto sm:w-[420px] glass-card-gold p-5 sm:p-6 flex flex-col gap-5 overflow-y-auto transition-all duration-300",
              mobileOpen
                ? "translate-y-0 opacity-100"
                : "translate-y-4 opacity-0",
            )}
          >
            <div className="flex items-start justify-between gap-4 border-b border-border-gold/15 pb-4">
              <div className="min-w-0">
                <p className="text-xs uppercase tracking-[0.28em] text-gold/70 font-body mb-2">
                  Hazina
                </p>
                <p className="text-sm text-foreground-muted font-body leading-relaxed">
                  {t("common.actions.browseData")}
                </p>
              </div>
              <button
                type="button"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-gold/15 bg-surface/60 text-foreground-muted hover:text-foreground hover:border-gold/30 transition-colors"
                onClick={() => setMobileOpen(false)}
                aria-label={t("nav.mobileMenu")}
              >
                <X className="w-5 h-5" aria-hidden="true" />
              </button>
            </div>

            <div className="rounded-2xl border border-gold/10 bg-void/25 p-3">
              <LocaleSwitcher className="w-full" />
            </div>

            <div className="flex flex-col gap-2">
              {NAV_LINKS.map(({ to, key, icon: Icon, dataTour }) => (
                <Link
                  key={to}
                  to={to}
                  data-tour={dataTour}
                  onClick={() => setMobileOpen(false)}
                  className={clsx(
                    "flex items-center justify-between gap-3 rounded-2xl px-4 py-3.5 text-sm font-medium font-body transition-all duration-200",
                    pathname === to
                      ? "bg-gold/15 text-gold border border-gold/25"
                      : "text-foreground-muted hover:text-foreground hover:bg-surface-2 border border-transparent",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                    <span className="truncate">{t(key)}</span>
                  </span>
                  <span className="text-gold/60 text-base" aria-hidden="true">
                    +
                  </span>
                </Link>
              ))}
            </div>

            <Link
              to="/marketplace"
              className="btn-gold text-sm text-center mt-auto whitespace-nowrap"
              onClick={() => setMobileOpen(false)}
            >
              {t("common.actions.browseData")}
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}
