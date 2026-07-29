import type {
  GuardianInboundMessage,
  GuardianOutboundMessage,
} from "#shared/prerequisites/guardian";
import { runGuardian } from "#shared/prerequisites/guardian";

let release: (() => Promise<void>) | undefined;
let initialized = false;
let initializedLeaseId: string | undefined;
let requestedLeaseId: string | undefined;
let disconnected = false;
let releaseStarted = false;

const send = (message: GuardianOutboundMessage) => process.send?.(message);
const fail = (error: unknown) => {
  send({ type: "ERROR", message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
};
const releaseIfRequested = () => {
  if (releaseStarted || !release || (!disconnected && requestedLeaseId !== initializedLeaseId)) {
    return;
  }
  releaseStarted = true;
  void release().catch(fail);
};

process.on("message", (message: GuardianInboundMessage) => {
  if (message.type === "INIT" && !initialized) {
    initialized = true;
    initializedLeaseId = message.leaseId;
    void runGuardian(message, send)
      .then((guardian) => {
        release = guardian.release;
        send({ type: "READY", leaseId: message.leaseId, guardianId: message.guardianId });
        return releaseIfRequested();
      })
      .catch(fail);
    return;
  }
  if (message.type === "RELEASE") {
    requestedLeaseId = message.leaseId;
    releaseIfRequested();
  }
});

process.on("disconnect", () => {
  disconnected = true;
  releaseIfRequested();
});
