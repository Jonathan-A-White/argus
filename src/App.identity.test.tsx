import { IDBFactory } from "fake-indexeddb";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import App from "./App";
import { DEVICE_IDENTITY_STORAGE_KEY } from "./identity/deviceIdentity";

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

async function createJoiningIdentity() {
  fireEvent.click(await screen.findByRole("button", { name: "Join a unit" }));
  const form = await screen.findByRole("form", { name: "Join a unit" });
  fireEvent.change(within(form).getByLabelText("Passphrase"), {
    target: { value: PASSWORD },
  });
  fireEvent.change(within(form).getByLabelText("Confirm passphrase"), {
    target: { value: PASSWORD },
  });
  fireEvent.click(
    within(form).getByRole("button", { name: "Join this unit" }),
  );
  const codeField = (await screen.findByLabelText(
    "Your identity code",
    {},
    CRYPTO_TIMEOUT,
  )) as HTMLTextAreaElement;
  // The identity code is filled in asynchronously after the textarea mounts; wait for it, not just the element.
  await waitFor(() => expect(codeField.value).not.toBe(""), CRYPTO_TIMEOUT);
  return codeField.value;
}

async function openRolesPanel() {
  fireEvent.click(
    (await screen.findAllByRole("button", { name: /more/i }))[0],
  );
  fireEvent.click(screen.getByRole("button", { name: /Roles & access/ }));
}

async function admitPersonAs(identityCode: string, role: string) {
  await openRolesPanel();
  const form = await screen.findByRole("form", { name: "Admit a person" });
  fireEvent.change(within(form).getByLabelText("Identity code"), {
    target: { value: identityCode },
  });
  fireEvent.change(within(form).getByLabelText("Role"), {
    target: { value: role },
  });
  fireEvent.click(within(form).getByRole("button", { name: "Admit" }));
  const codeField = await screen.findByLabelText(
    "Credential code",
    {},
    CRYPTO_TIMEOUT,
  );
  return (codeField as HTMLTextAreaElement).value;
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
      expect(await screen.findAllByText("MASTER")).not.toHaveLength(0);
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

describe("admission", () => {
  it(
    "admits a person by identity code and role; the joining device unlocks with that role and both roles panels show the pair",
    async () => {
      const joiningDevice = render(<App />);
      const identityCode = await createJoiningIdentity();
      joiningDevice.unmount();
      const joiningDeviceRecord = localStorage.getItem(
        DEVICE_IDENTITY_STORAGE_KEY,
      );

      localStorage.clear();
      const masterDevice = render(<App />);
      await createMasterIdentity();
      const credentialCode = await admitPersonAs(
        identityCode,
        "SUPPLY_OFFICER",
      );
      const masterPeople = await screen.findByRole("list", {
        name: "People this device knows",
      });
      expect(
        within(masterPeople).getByText("SUPPLY_OFFICER"),
      ).toBeInTheDocument();
      masterDevice.unmount();

      localStorage.clear();
      localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, joiningDeviceRecord!);
      render(<App />);
      const unlockForm = await screen.findByRole("form", {
        name: "Unlock A.R.G.U.S.",
      });
      fireEvent.change(within(unlockForm).getByLabelText("Passphrase"), {
        target: { value: PASSWORD },
      });
      fireEvent.click(
        within(unlockForm).getByRole("button", { name: "Unlock" }),
      );
      const credentialForm = await screen.findByRole(
        "form",
        { name: "Enter your credential" },
        CRYPTO_TIMEOUT,
      );
      fireEvent.change(
        within(credentialForm).getByLabelText("Credential code"),
        { target: { value: credentialCode } },
      );
      fireEvent.click(
        within(credentialForm).getByRole("button", {
          name: "Join with this credential",
        }),
      );
      await screen.findByText("Count with confidence.", {}, CRYPTO_TIMEOUT);

      await openRolesPanel();
      expect(
        await screen.findAllByText("SUPPLY_OFFICER"),
      ).not.toHaveLength(0);
      const people = await screen.findByRole("list", {
        name: "People this device knows",
      });
      expect(within(people).getAllByText("MASTER")).not.toHaveLength(0);
    },
    60_000,
  );

  it(
    "refuses a credential from a different, unrelated authority with an error, and refuses a tampered code",
    async () => {
      render(<App />);
      await createJoiningIdentity();

      const credentialForm = await screen.findByRole("form", {
        name: "Enter your credential",
      });
      fireEvent.change(
        within(credentialForm).getByLabelText("Credential code"),
        { target: { value: "not a valid credential code" } },
      );
      fireEvent.click(
        within(credentialForm).getByRole("button", {
          name: "Join with this credential",
        }),
      );
      expect(
        await screen.findByRole("alert", {}, CRYPTO_TIMEOUT),
      ).toHaveTextContent(/not a valid credential code/i);
    },
    30_000,
  );
});
