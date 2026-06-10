/**
 * INTENTIONAL ADR-0019 VIOLATION FIXTURE
 *
 * Proves direct provider SDK imports are rejected outside keiko-model-gateway.
 */
import OpenAI from "openai";

export const violation = OpenAI;
