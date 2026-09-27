// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectModal, TEMPLATES } from "./ProjectModal";

afterEach(cleanup);

/**
 * The dialog is two steps now: the architecture grid first, then the name and
 * folder. These helpers walk it the way a person does, so each test says which
 * step it is asserting about rather than reaching past the UI.
 */
function continueToDetails() {
  fireEvent.click(screen.getByRole("button", { name: /continue/i }));
}

function fillIn(name: string) {
  fireEvent.change(screen.getByPlaceholderText(/user-auth-service/i), {
    target: { value: name },
  });
}

function create() {
  fireEvent.click(screen.getByRole("button", { name: /create project/i }));
}

describe("the new-project dialog", () => {
  it("stays open with the input intact when scaffolding fails", async () => {
    // The regression this pins: the dialog used to close (and clear the name)
    // *before* the write was attempted, so a failure surfaced as a bare alert
    // with the user's work already thrown away.
    const onClose = vi.fn();
    const onCreateProject = vi
      .fn()
      .mockRejectedValue(new Error("Failed to create project directory: Permission denied"));

    render(<ProjectModal isOpen onClose={onClose} onCreateProject={onCreateProject} />);
    continueToDetails();
    fillIn("my-app");
    create();

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Permission denied/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    // Still there to fix, rather than retyped from scratch.
    expect((screen.getByPlaceholderText(/user-auth-service/i) as HTMLInputElement).value).toBe(
      "my-app",
    );
  });

  it("passes the name, template and destination through, then closes", async () => {
    const onClose = vi.fn();
    const onCreateProject = vi.fn().mockResolvedValue(undefined);

    render(<ProjectModal isOpen onClose={onClose} onCreateProject={onCreateProject} />);
    continueToDetails();
    fillIn("My New App");
    fireEvent.change(screen.getByDisplayValue("~/AcsaProjects"), {
      target: { value: "~/Desktop/Work" },
    });
    create();

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // Slugs are normalised, and the destination travels untouched (the shell
    // shorthand is expanded on the Rust side, not here).
    expect(onCreateProject).toHaveBeenCalledWith("my-new-app", "nextjs", "~/Desktop/Work");
  });

  it("will not create without a name", () => {
    const onCreateProject = vi.fn();
    render(<ProjectModal isOpen onClose={vi.fn()} onCreateProject={onCreateProject} />);
    continueToDetails();

    const button = screen.getByRole("button", { name: /create project/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onCreateProject).not.toHaveBeenCalled();
  });
});

/**
 * The wizard itself. Splitting the form was the point of the change, so the
 * steps are asserted rather than assumed.
 */
describe("the new-project dialog, as two steps", () => {
  it("opens on the architecture step and says so", () => {
    render(<ProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />);
    expect(screen.getByText(/step 1 of 2/i)).toBeTruthy();
    // Every template is offered, and none of the destination fields are yet.
    for (const t of TEMPLATES) {
      expect(screen.getByRole("button", { name: new RegExp(t.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })).toBeTruthy();
    }
    expect(screen.queryByPlaceholderText(/user-auth-service/i)).toBeNull();
  });

  it("carries the chosen template through to creation", async () => {
    const onCreateProject = vi.fn().mockResolvedValue(undefined);
    render(<ProjectModal isOpen onClose={vi.fn()} onCreateProject={onCreateProject} />);

    // Pick a non-default template off the grid.
    fireEvent.click(screen.getByRole("button", { name: /Python FastAPI/i }));
    continueToDetails();
    expect(screen.getByText(/step 2 of 2/i)).toBeTruthy();
    fillIn("billing-api");
    create();

    await waitFor(() => expect(onCreateProject).toHaveBeenCalled());
    expect(onCreateProject).toHaveBeenCalledWith("billing-api", "fastapi", "~/AcsaProjects");
  });

  it("shows the folder the two fields add up to", () => {
    render(<ProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />);
    continueToDetails();

    // Before a name, the path says so rather than showing a broken join.
    expect(screen.getByTestId("projectmodal-destination").textContent).toBe("~/AcsaProjects/…");

    fillIn("My New App");
    expect(screen.getByTestId("projectmodal-destination").textContent).toBe(
      "~/AcsaProjects/my-new-app",
    );

    fireEvent.change(screen.getByDisplayValue("~/AcsaProjects"), { target: { value: "/tmp/work/" } });
    // A trailing slash must not double up.
    expect(screen.getByTestId("projectmodal-destination").textContent).toBe("/tmp/work/my-new-app");
  });

  it("goes back to the architecture step from either control", () => {
    render(<ProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />);
    continueToDetails();

    fireEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.getByText(/step 1 of 2/i)).toBeTruthy();

    continueToDetails();
    fireEvent.click(screen.getByRole("button", { name: /^change$/i }));
    expect(screen.getByText(/step 1 of 2/i)).toBeTruthy();
  });
});

/**
 * The dialog's keyboard contract. There was no focus trap anywhere in the app:
 * a dialog that looks modal but lets Tab walk out into the page behind it is
 * worse than no dialog styling, because the user cannot see where they are.
 */
describe("the new-project dialog, from the keyboard", () => {
  it("closes on Escape", async () => {
    const onClose = vi.fn();
    render(<ProjectModal isOpen onClose={onClose} onCreateProject={vi.fn()} />);

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("keeps Tab inside the dialog, on both steps", async () => {
    render(<ProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");

    // Enabled only: a disabled control is not a tab stop, and `last.focus()` on
    // one silently does nothing — which is what made this assertion fail first.
    const assertTrap = () => {
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
        ),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      expect(first).toBeTruthy();
      expect(last).not.toBe(first);

      // Forward from the end wraps to the start…
      last.focus();
      fireEvent.keyDown(document, { key: "Tab" });
      expect(document.activeElement).toBe(first);

      // …and backwards from the start wraps to the end.
      first.focus();
      fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
      expect(document.activeElement).toBe(last);
    };

    assertTrap();
    continueToDetails();
    assertTrap();
  });

  it("is announced as a modal dialog, not an anonymous box", async () => {
    render(<ProjectModal isOpen onClose={vi.fn()} onCreateProject={vi.fn()} />);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-label")).toBeTruthy();
  });
});
