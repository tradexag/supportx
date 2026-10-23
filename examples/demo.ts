import { evaluateAutoReply } from "../packages/core/policy.ts";
import { exampleContext } from "./fixture.ts";

const context = exampleContext();
console.log("ARCHITECTURE DEMO — synthetic data, no network, no messages sent.");
console.log("Default without an explicit policy:");
console.log(JSON.stringify(evaluateAutoReply({ ...context, policy: undefined }), null, 2));
console.log("Explicit autopilot with verified sample facts:");
console.log(JSON.stringify(evaluateAutoReply(context), null, 2));
