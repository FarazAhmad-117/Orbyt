import { organizationMembers, eq, users } from "@orbyt/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./test-utils";

let t: TestApp;
type User = Awaited<ReturnType<TestApp["signUp"]>>;
let owner: User;
let teammate: User;
let outsider: User;

beforeAll(async () => {
  t = await createTestApp();
  owner = await t.signUp("Owner");
  teammate = await t.signUp("Teammate");
  outsider = await t.signUp("Outsider");
});
afterAll(() => t.cleanup());

const as = (u: User) => ({
  get: (p: string) => t.request("GET", p, { cookie: u.cookie }),
  post: (p: string, payload?: unknown) =>
    t.request("POST", p, { cookie: u.cookie, payload: payload ?? {} }),
  del: (p: string) => t.request("DELETE", p, { cookie: u.cookie }),
});
const orgsOf = async (u: User) =>
  (await as(u).get("/api/orgs")).json() as {
    id: string;
    name: string;
    role: string;
  }[];
const workspacesOf = async (u: User) =>
  (await as(u).get("/api/me/workspaces")).json() as {
    id: string;
    name: string;
  }[];
const userId = async (u: User) =>
  (
    await t.dbs.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, u.email))
  )[0]!.id;

describe("agency mode: sub-accounts", () => {
  it("an organization owner creates a second workspace and sees both", async () => {
    const [org] = await orgsOf(owner);
    expect(org).toMatchObject({ role: "owner" });
    const created = await as(owner).post(`/api/orgs/${org!.id}/workspaces`, {
      name: "Client A",
    });
    expect(created.statusCode).toBe(201);
    const names = (await workspacesOf(owner)).map((w) => w.name).sort();
    expect(names).toEqual(["Client A", "Default"]);

    // The new workspace is fully usable and isolated from everyone else.
    const clientA = created.json() as { id: string };
    const contact = await t.request("POST", `/api/w/${clientA.id}/contacts`, {
      cookie: owner.cookie,
      payload: { email: "c@client-a.test" },
    });
    expect(contact.statusCode).toBe(201);
    expect(
      (
        await t.request("GET", `/api/w/${clientA.id}/contacts`, {
          cookie: outsider.cookie,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.request("GET", `${owner.base}/contacts`, {
          cookie: owner.cookie,
        })
      ).json().items,
    ).toHaveLength(0); // separate data
  });

  it("validates, and never reveals or touches another organization", async () => {
    const [org] = await orgsOf(owner);
    expect(
      (await as(owner).post(`/api/orgs/${org!.id}/workspaces`, { name: "" }))
        .statusCode,
    ).toBe(400);
    expect(
      (await as(owner).post(`/api/orgs/not-a-uuid/workspaces`, { name: "x" }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await as(outsider).post(`/api/orgs/${org!.id}/workspaces`, {
          name: "Sneaky",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await t.request("POST", `/api/orgs/${org!.id}/workspaces`, {
          payload: { name: "x" },
        })
      ).statusCode,
    ).toBe(401);
    expect((await orgsOf(outsider)).some((o) => o.id === org!.id)).toBe(false);
    expect((await workspacesOf(outsider)).map((w) => w.name)).not.toContain(
      "Sneaky",
    );
  });

  it("a plain organization member cannot create workspaces", async () => {
    const [org] = await orgsOf(owner);
    await t.dbs.db.insert(organizationMembers).values({
      organizationId: org!.id,
      userId: await userId(teammate),
      role: "member",
    });
    const res = await as(teammate).post(`/api/orgs/${org!.id}/workspaces`, {
      name: "Nope",
    });
    expect(res.statusCode).toBe(403);
    await t.dbs.db
      .delete(organizationMembers)
      .where(eq(organizationMembers.userId, await userId(teammate)));
  });
});

describe("workspace members and roles", () => {
  it("lists members, adds an existing user by email, and lets them in", async () => {
    expect((await as(teammate).get(`${owner.base}/contacts`)).statusCode).toBe(
      404,
    ); // not a member yet
    const before = (await as(owner).get(`${owner.base}/members`)).json() as {
      email: string;
      role: string;
    }[];
    expect(before.map((m) => m.email)).toEqual([owner.email]);

    const added = await as(owner).post(`${owner.base}/members`, {
      email: teammate.email.toUpperCase(),
      role: "member",
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({
      email: teammate.email,
      role: "member",
    });
    expect((await as(teammate).get(`${owner.base}/contacts`)).statusCode).toBe(
      200,
    );
    expect((await workspacesOf(teammate)).map((w) => w.id)).toContain(
      owner.workspaceId,
    );
    expect(
      (await as(teammate).get(`${owner.base}/members`)).json(),
    ).toHaveLength(2); // members can see the team

    expect(
      (
        await as(owner).post(`${owner.base}/members`, {
          email: "nobody@example.test",
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await as(owner).post(`${owner.base}/members`, { email: "bad" }))
        .statusCode,
    ).toBe(400);
  });

  it("only admins manage credentials, keys, integrations and the team", async () => {
    // teammate is a plain member of owner's workspace from the previous test.
    const forbidden = [
      () => as(teammate).get(`${owner.base}/api-keys`),
      () => as(teammate).post(`${owner.base}/api-keys`, { name: "x" }),
      () => as(teammate).get(`${owner.base}/webhooks`),
      () => as(teammate).get(`${owner.base}/ai/providers`),
      () =>
        as(teammate).post(`${owner.base}/members`, { email: outsider.email }),
      () =>
        as(teammate).post(`${owner.base}/channels`, {
          type: "retell",
          name: "r",
          address: "+14155550101",
          apiKey: "retell-key-12345",
        }),
      () =>
        as(teammate).post(`${owner.base}/mailboxes`, {
          email: "a@b.co",
          verify: false,
          smtp: { host: "h", port: 25, user: "u", password: "p" },
          imap: { host: "h", port: 143, user: "u", password: "p" },
        }),
    ];
    for (const call of forbidden) expect((await call()).statusCode).toBe(403);
    // ...but they can do the day-to-day work.
    expect(
      (
        await as(teammate).post(`${owner.base}/contacts`, {
          email: "work@example.test",
        })
      ).statusCode,
    ).toBe(201);
    expect((await as(teammate).get(`${owner.base}/mailboxes`)).statusCode).toBe(
      200,
    );
    expect((await as(teammate).get(`${owner.base}/channels`)).statusCode).toBe(
      200,
    );
    // The admin can.
    expect((await as(owner).get(`${owner.base}/api-keys`)).statusCode).toBe(
      200,
    );
  });

  it("promotes, removes, and keeps at least one admin", async () => {
    const mateId = await userId(teammate);
    const ownerId = await userId(owner);
    await as(owner).post(`${owner.base}/members`, {
      email: teammate.email,
      role: "admin",
    });
    expect((await as(teammate).get(`${owner.base}/api-keys`)).statusCode).toBe(
      200,
    ); // now an admin
    expect(
      (await as(teammate).del(`${owner.base}/members/${ownerId}`)).statusCode,
    ).toBe(204); // admins can remove admins
    expect((await as(owner).get(`${owner.base}/members`)).statusCode).toBe(200); // owner is an org owner: still has access
    // The last workspace admin cannot be removed.
    expect(
      (await as(teammate).del(`${owner.base}/members/${mateId}`)).statusCode,
    ).toBe(400);
    expect(
      (
        await as(teammate).del(
          `${owner.base}/members/${await userId(outsider)}`,
        )
      ).statusCode,
    ).toBe(404);
    // Re-add the owner as a plain member, then remove the teammate-admin's last-admin protection no longer matters.
    await as(owner).post(`${owner.base}/members`, {
      email: owner.email,
      role: "admin",
    });
    expect(
      (await as(owner).del(`${owner.base}/members/${mateId}`)).statusCode,
    ).toBe(204);
    expect((await as(teammate).get(`${owner.base}/contacts`)).statusCode).toBe(
      404,
    ); // access is gone
  });

  it("organization owners count as admins of every workspace, and the agency is listed", async () => {
    const [org] = await orgsOf(owner);
    const clientB = (
      await as(owner).post(`/api/orgs/${org!.id}/workspaces`, {
        name: "Client B",
      })
    ).json() as { id: string };
    const ownerId = await userId(owner);
    await as(owner)
      .del(`/api/w/${clientB.id}/members/${ownerId}`)
      .catch(() => undefined); // last admin: refused
    const members = (
      await as(owner).get(`/api/w/${clientB.id}/members`)
    ).json() as { email: string; via: string }[];
    expect(members.some((m) => m.email === owner.email)).toBe(true);
    // API keys (never a user) cannot reach admin endpoints even for an admin's workspace.
    const key = (
      await as(owner).post(`/api/w/${clientB.id}/api-keys`, { name: "k" })
    ).json().key as string;
    expect(
      (await t.request("GET", `/api/w/${clientB.id}/api-keys`, { bearer: key }))
        .statusCode,
    ).toBe(403);
    expect(
      (await t.request("GET", `/api/w/${clientB.id}/contacts`, { bearer: key }))
        .statusCode,
    ).toBe(200);
  });
});
