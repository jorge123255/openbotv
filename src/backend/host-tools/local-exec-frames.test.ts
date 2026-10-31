import { describe, expect, it } from "vitest";
import {
  decodeListedMachines,
  decodeRequestFrame,
  hostRequestFromExec,
  LOCAL_EXEC_REQUESTS_PATH,
  LOCAL_EXEC_RESPONSES_PATH,
  localExecHeaders,
  responsePostBody,
  selectMachine,
} from "./local-exec-frames";

const session = {
  token: "gateway-bearer",
  headers: { "x-anyrun-network-token": "net-1" },
  accessToken: "user-sand-access-token",
};

describe("local-exec frames", () => {
  it("reads requests on GET /local-exec/requests", () => {
    expect(LOCAL_EXEC_REQUESTS_PATH).toBe("/local-exec/requests");
    expect(LOCAL_EXEC_RESPONSES_PATH).toBe("/local-exec/responses");
  });

  it("sends the gateway bearer and omits the user sand access token", () => {
    const headers = localExecHeaders(session);
    expect(headers.authorization).toBe("Bearer gateway-bearer");
    expect(headers["x-anyrun-network-token"]).toBe("net-1");
    expect(JSON.stringify(headers).includes("user-sand-access-token")).toBe(false);
    expect(JSON.stringify(headers).includes("accessToken")).toBe(false);
  });

  it("carries machineId and one request id on shell and screenshot", () => {
    const shell = hostRequestFromExec(
      "req-1",
      {
        message: {
          case: "shellStreamArgs",
          value: { command: "echo host-tool-ok", workingDirectory: "/tmp" },
        },
      },
      "mac-1",
    );
    expect(shell).toMatchObject({
      id: "req-1",
      action: "shell",
      machineId: "mac-1",
      command: "echo host-tool-ok",
    });
    const shot = hostRequestFromExec(
      "req-2",
      {
        message: { case: "computerUseArgs", value: { actions: [{ action: { case: "screenshot" } }] } },
      },
      "mac-1",
    );
    expect(shot).toMatchObject({ id: "req-2", action: "screenshot", machineId: "mac-1" });
  });

  it("repeats the request id on the response post", () => {
    const body = responsePostBody("prov-1", [
      { kind: "client", requestId: "req-1", message: { shellResult: { success: { stdout: "ok", exitCode: 0 } } } },
    ]);
    expect(body.providerId).toBe("prov-1");
    expect(body.frames[0]).toMatchObject({ requestId: "req-1" });
  });

  it("decodes listComputers ids and a machines wrapper", () => {
    expect(decodeListedMachines([{ id: "mac-1", label: "Mac", connected: true }])).toEqual([
      { id: "mac-1", label: "Mac", connected: true },
    ]);
    expect(decodeListedMachines({ machines: [{ machineId: "mac-2", connected: true }] })).toEqual([
      { id: "mac-2", label: "", connected: true },
    ]);
  });

  it("uses the only connected machine and refuses an unknown id", () => {
    const machines = [{ id: "mac-1", label: "Mac", connected: true }];
    expect(selectMachine(machines, undefined)).toEqual({ ok: true, machine: machines[0] });
    expect(selectMachine(machines, "other")).toEqual({ ok: false, code: "unavailable" });
    expect(
      selectMachine(
        [
          { id: "a", label: "A", connected: true },
          { id: "b", label: "B", connected: true },
        ],
        undefined,
      ),
    ).toEqual({ ok: false, code: "unavailable" });
    expect(selectMachine([], "mac-1")).toEqual({ ok: false, code: "unavailable" });
  });

  it("decodes device, upload, and download frames for the runner to refuse", () => {
    expect(
      decodeRequestFrame({ kind: "device", requestId: "d1", request: { operation: "chrome-cookies" } })?.kind,
    ).toBe("device");
    expect(decodeRequestFrame({ kind: "upload", requestId: "u1", path: "/tmp/a", bytesBase64: "YQ==" })?.kind).toBe(
      "upload",
    );
    expect(decodeRequestFrame({ kind: "download", requestId: "n1", path: "/tmp/a" })?.kind).toBe("download");
    expect(hostRequestFromExec("d1", { message: { case: "mcpArgs", value: {} } })).toMatchObject({
      action: "mcp",
      id: "d1",
    });
  });
});
