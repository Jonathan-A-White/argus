import { IDBFactory } from "fake-indexeddb";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";

const originalIndexedDb = globalThis.indexedDB;
beforeEach(() => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: new IDBFactory(),
  });
});
afterEach(() => {
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: originalIndexedDb,
  });
});

const PASSWORD = "correct horse battery 7";
// Each wrapped credential runs 600,000 PBKDF2 iterations by design (identity.ts); Master
// creation wraps two keys, so generous timeouts are needed under coverage/CI load.
const CRYPTO_TIMEOUT = { timeout: 20_000 };

async function createMasterIdentity() {
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Create this unit's Master identity",
    }),
  );
  const form = await screen.findByRole("form", {
    name: "Create this unit's Master identity",
  });
  fireEvent.change(within(form).getByLabelText("Passphrase"), {
    target: { value: PASSWORD },
  });
  fireEvent.change(within(form).getByLabelText("Confirm passphrase"), {
    target: { value: PASSWORD },
  });
  fireEvent.click(
    within(form).getByRole("button", { name: "Create Master identity" }),
  );
  await screen.findByText("Count with confidence.", {}, CRYPTO_TIMEOUT);
}

describe("device identity gate", () => {
  it(
    "shows the first-run choice, and creating the Master identity leads to the app with role MASTER in the roles panel",
    async () => {
      render(<App />);
      await screen.findByText(
        "A.R.G.U.S. has not been set up on this device yet.",
      );
      await createMasterIdentity();
      fireEvent.click(
        (await screen.findAllByRole("button", { name: /more/i }))[0],
      );
      fireEvent.click(screen.getByRole("button", { name: /Roles & access/ }));
      expect(await screen.findByText("MASTER")).toBeInTheDocument();
    },
    30_000,
  );

  it(
    "shows the unlock screen on reload, refuses a wrong passphrase, and unlocks with the right one",
    async () => {
      const first = render(<App />);
      await createMasterIdentity();
      first.unmount();

      render(<App />);
      const unlockForm = await screen.findByRole("form", {
        name: "Unlock A.R.G.U.S.",
      });
      fireEvent.change(within(unlockForm).getByLabelText("Passphrase"), {
        target: { value: "totally wrong passphrase 9" },
      });
      fireEvent.click(
        within(unlockForm).getByRole("button", { name: "Unlock" }),
      );
      expect(
        await screen.findByRole("alert", {}, CRYPTO_TIMEOUT),
      ).toHaveTextContent(/incorrect/i);
      expect(
        screen.getByRole("form", { name: "Unlock A.R.G.U.S." }),
      ).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText("Passphrase"), {
        target: { value: PASSWORD },
      });
      fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
      await screen.findByText("Count with confidence.", {}, CRYPTO_TIMEOUT);
    },
    30_000,
  );

  it(
    "locks from the more tab and returns to the unlock screen",
    async () => {
      render(<App />);
      await createMasterIdentity();
      fireEvent.click(
        (await screen.findAllByRole("button", { name: /more/i }))[0],
      );
      fireEvent.click(
        screen.getByRole("button", { name: /Lock this device/i }),
      );
      expect(
        await screen.findByRole("form", { name: "Unlock A.R.G.U.S." }),
      ).toBeInTheDocument();
    },
    30_000,
  );
});
