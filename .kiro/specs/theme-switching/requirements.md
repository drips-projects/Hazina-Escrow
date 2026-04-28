# Requirements Document

## Introduction

The Hazina Data Escrow frontend requires a complete, centralized dark/light theme switching mechanism. Currently, the `ThemeToggle` component manages theme state locally, which prevents other components from reading or reacting to the active theme. This feature introduces a shared `ThemeContext` and `useTheme` hook so that theme state is managed in one place, persisted across sessions via `localStorage`, defaults to the OS-level `prefers-color-scheme` preference, and is applied by toggling a `dark` class on the `<html>` element using Tailwind CSS's `class` dark mode strategy.

## Glossary

- **Theme_Context**: The React context that holds and distributes the current theme state and toggle function to the component tree.
- **Theme_Provider**: The React context provider component that wraps the application and owns the theme state.
- **useTheme**: The custom React hook that consumes `Theme_Context` and exposes `theme` and `toggleTheme` to consumers.
- **ThemeToggle**: The existing UI button component at `frontend/src/components/ThemeToggle.tsx` that calls `useTheme` to read and change the theme.
- **Theme**: A string value of either `"dark"` or `"light"`.
- **localStorage**: The browser Web Storage API used to persist the user's theme preference across sessions.
- **prefers-color-scheme**: The CSS media query that reflects the OS-level color scheme preference.
- **Tailwind_Dark_Mode**: Tailwind CSS's `darkMode: 'class'` strategy, which activates dark-variant utilities when the `dark` class is present on the `<html>` element.

## Requirements

### Requirement 1: Theme Context and Hook

**User Story:** As a developer, I want a centralized theme context and hook, so that any component in the tree can read and change the active theme without prop drilling.

#### Acceptance Criteria

1. THE Theme_Provider SHALL expose a `theme` value of type `"dark" | "light"` and a `toggleTheme` function through `Theme_Context`.
2. THE useTheme hook SHALL return the current `theme` value and the `toggleTheme` function when called inside a `Theme_Provider`.
3. IF useTheme is called outside a `Theme_Provider`, THEN THE useTheme hook SHALL throw an error with a descriptive message.
4. WHEN `toggleTheme` is called, THE Theme_Provider SHALL switch `theme` from `"dark"` to `"light"` or from `"light"` to `"dark"`.

---

### Requirement 2: Default Theme from OS Preference

**User Story:** As a user, I want the app to respect my OS color scheme preference on first visit, so that I don't have to manually set the theme.

#### Acceptance Criteria

1. WHEN no theme value is stored in `localStorage`, THE Theme_Provider SHALL initialize `theme` to `"dark"` if `window.matchMedia('(prefers-color-scheme: dark)').matches` is `true`.
2. WHEN no theme value is stored in `localStorage`, THE Theme_Provider SHALL initialize `theme` to `"light"` if `window.matchMedia('(prefers-color-scheme: dark)').matches` is `false`.

---

### Requirement 3: Theme Persistence

**User Story:** As a user, I want my theme preference saved across browser sessions, so that I don't have to re-select it every time I visit.

#### Acceptance Criteria

1. WHEN `toggleTheme` is called, THE Theme_Provider SHALL write the new `theme` value to `localStorage` under the key `"hazina-theme"`.
2. WHEN the application initializes and a value of `"dark"` or `"light"` is stored under `"hazina-theme"` in `localStorage`, THE Theme_Provider SHALL initialize `theme` to that stored value.
3. IF an unrecognized value is stored under `"hazina-theme"` in `localStorage`, THEN THE Theme_Provider SHALL ignore it and fall back to the `prefers-color-scheme` default.

---

### Requirement 4: DOM Class Application

**User Story:** As a developer, I want the theme applied via a `dark` class on `<html>`, so that Tailwind CSS dark-mode utilities activate correctly across the entire page.

#### Acceptance Criteria

1. WHEN `theme` is `"dark"`, THE Theme_Provider SHALL ensure the `dark` class is present on `document.documentElement`.
2. WHEN `theme` is `"light"`, THE Theme_Provider SHALL ensure the `dark` class is absent from `document.documentElement`.
3. THE Theme_Provider SHALL apply the correct `dark` class state on initial render before the first paint to prevent a flash of incorrect theme.

---

### Requirement 5: ThemeToggle Component Wiring

**User Story:** As a user, I want the theme toggle button to reflect and change the current theme, so that I can switch between dark and light modes from the UI.

#### Acceptance Criteria

1. THE ThemeToggle component SHALL consume `useTheme` to read the current `theme` and call `toggleTheme` when clicked.
2. WHEN `theme` is `"dark"`, THE ThemeToggle component SHALL render a Sun icon and set `aria-label` to `"Switch to light mode"`.
3. WHEN `theme` is `"light"`, THE ThemeToggle component SHALL render a Moon icon and set `aria-label` to `"Switch to dark mode"`.
4. THE ThemeToggle component SHALL NOT manage its own theme state independently of `useTheme`.

---

### Requirement 6: Tailwind Dark Mode Configuration

**User Story:** As a developer, I want Tailwind configured to use the `class` dark mode strategy, so that dark-variant utilities are controlled by the `dark` class on `<html>`.

#### Acceptance Criteria

1. THE Tailwind_Dark_Mode configuration in `tailwind.config.js` SHALL set `darkMode` to `"class"`.

---

### Requirement 7: Provider Integration

**User Story:** As a developer, I want the `Theme_Provider` mounted at the application root, so that all components in the tree have access to the theme context.

#### Acceptance Criteria

1. THE Theme_Provider SHALL be rendered as an ancestor of `App` in `main.tsx`.
2. WHEN the application mounts, THE Theme_Provider SHALL initialize the theme and apply the `dark` class to `document.documentElement` before child components render.
