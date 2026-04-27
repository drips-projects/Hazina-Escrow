import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import TermsPage from "./TermsPage";

describe("TermsPage", () => {
  it("renders the terms page with the testnet disclaimer visible", () => {
    render(
      <MemoryRouter initialEntries={["/terms"]}>
        <Routes>
          <Route path="/terms" element={<TermsPage />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        /This is a testnet application\. Do not use real funds\. All transactions and balances on Hazina are for demonstration and development purposes only\./i,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Service description/i)).toBeTruthy();
    expect(screen.getByText(/Limitation of liability/i)).toBeTruthy();
  });
});
