# Implementation Plan: Theme Switching

## Overview

Implement a centralized theme management system using React Context, refactor `ThemeToggle` to consume it, wire the provider into `main.tsx`, and configure Tailwind's `class` dark mode strategy.

## Tasks

- [ ] 1. Configure Tailwind dark mode strategy
  - Add `darkMode: 'class'` to `tailwind.config.js`
  - _Requirements: 6.1_

- [ ] 2. Create ThemeContext with provider and hook
  - Create `frontend/src/context/ThemeContext.tsx`
  - Implement `getInitialTheme()` — reads `localStorage`, falls back to `prefers-color-scheme`, defaults to `"dark"`
  - Implement `ThemeProvider` — owns `theme` state, syncs `dark` class on `document.documentElement` and writes to `localStorage` in a `useEffect`
  - Implement `useTheme` hook — consumes context, throws descriptive error if used outside provider
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_

  - [ ]* 2.1 Write property test: toggle is an involution
    - **Property 1: Toggle is an involution (round-trip)**
    - **Validates: Requirements 1.4**
    - For any initial theme, toggling twice restores the original value
    - `// Feature: theme-switching, Property 1: toggle involution`

  - [ ]* 2.2 Write property test: localStorage persistence on toggle
    - **Property 2: localStorage persistence on toggle**
    - **Validates: Requirements 3.1**
    - For any theme, after toggling, `localStorage.getItem("hazina-theme")` equals the new theme
    - `// Feature: theme-switching, Property 2: localStorage persistence`

  - [ ]* 2.3 Write property test: DOM class reflects theme state
    - **Property 3: DOM class reflects theme state**
    - **Validates: Requirements 4.1, 4.2**
    - For any theme value, `document.documentElement.classList.contains("dark")` iff `theme === "dark"`
    - `// Feature: theme-switching, Property 3: DOM class reflects theme`

  - [ ]* 2.4 Write property test: stored valid value takes precedence over OS preference
    - **Property 4: localStorage initialization takes precedence over OS preference**
    - **Validates: Requirements 3.2**
    - For any stored `"dark"` | `"light"` value, initialized theme equals stored value regardless of matchMedia
    - `// Feature: theme-switching, Property 4: stored value precedence`

  - [ ]* 2.5 Write property test: invalid stored value falls back to OS preference
    - **Property 5: Invalid localStorage values fall back to OS preference**
    - **Validates: Requirements 3.3, 2.1, 2.2**
    - For any string that is not `"dark"` or `"light"`, initialized theme equals OS preference
    - `// Feature: theme-switching, Property 5: invalid value fallback`

  - [ ]* 2.6 Write edge-case test: useTheme outside provider throws
    - **Property 6: useTheme outside provider throws**
    - **Validates: Requirements 1.3**
    - Calling `useTheme` without a `ThemeProvider` ancestor always throws
    - `// Feature: theme-switching, Property 6: useTheme outside provider`

- [ ] 3. Checkpoint — Ensure all ThemeContext tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 4. Refactor ThemeToggle to consume useTheme
  - Remove all local state (`useState`, `useEffect`, `getInitialIsDark`) from `ThemeToggle.tsx`
  - Replace with `const { theme, toggleTheme } = useTheme()`
  - Render Sun icon + `aria-label="Switch to light mode"` when `theme === "dark"`
  - Render Moon icon + `aria-label="Switch to dark mode"` when `theme === "light"`
  - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [ ]* 4.1 Write property test: ThemeToggle icon and label match theme
    - For any theme value rendered via ThemeProvider, ThemeToggle shows the correct icon and aria-label
    - `// Feature: theme-switching, Property 3 (component): icon and label match theme`
    - _Requirements: 5.2, 5.3_

  - [ ]* 4.2 Write unit test: clicking ThemeToggle calls toggleTheme
    - Render ThemeToggle inside ThemeProvider, click button, assert theme flips
    - _Requirements: 5.1_

- [ ] 5. Wire ThemeProvider into main.tsx
  - Import `ThemeProvider` from `./context/ThemeContext`
  - Wrap the existing provider tree so `ThemeProvider` is the outermost wrapper inside `React.StrictMode`
  - _Requirements: 7.1, 7.2_

- [ ] 6. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
