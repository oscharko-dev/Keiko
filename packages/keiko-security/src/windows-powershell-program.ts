// Shared scaffolding for the fixed inbox-PowerShell programs Keiko runs to read Windows facts that
// Node cannot reach (windows-local-volume.ts, windows-owner-private.ts). Each program stays a fixed
// literal that receives its inputs on standard input; only this scaffolding is shared, so the
// P/Invoke declaration style, the trusted environment and the output decoding cannot drift apart.
import { win32 as win32Path } from "node:path";

const ASSEMBLY_NAME = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;

/**
 * PowerShell source that defines `$type` and a `pinvoke($name, $returnType, $parameters)` helper
 * declaring kernel32 functions in one dynamic assembly. The caller declares its functions, then
 * calls `$type.CreateType()`. The name is a fixed identifier, never caller data.
 */
export function kernel32PInvokePrelude(assemblyName: string): string {
  if (!ASSEMBLY_NAME.test(assemblyName)) throw new TypeError("assembly name must be an identifier");
  return String.raw`  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly([Reflection.AssemblyName]::new('${assemblyName}'), [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('${assemblyName}')
  $type = $module.DefineType('${assemblyName}Api', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $attributes = [Reflection.MethodAttributes]'Public, Static, PinvokeImpl'
  function pinvoke($name, $returnType, $parameters) {
    $method = $type.DefinePInvokeMethod($name, 'kernel32.dll', $name, $attributes, [Reflection.CallingConventions]::Standard, $returnType, [type[]]$parameters, [Runtime.InteropServices.CallingConvention]::Winapi, [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)
    return $method
  }
`;
}

/** `-EncodedCommand` form of a fixed program: Base64 of its UTF-16LE text. */
export function encodePowerShellProgram(source: string): string {
  return Buffer.from(source, "utf16le").toString("base64");
}

/**
 * The only environment a program receives, derived from the identity-validated
 * `<SystemRoot>\System32\WindowsPowerShell\v1.0\powershell.exe`.
 */
export function trustedPowerShellEnvironment(executable: string): NodeJS.ProcessEnv {
  const root = win32Path.dirname(
    win32Path.dirname(win32Path.dirname(win32Path.dirname(executable))),
  );
  return { SystemRoot: root, WINDIR: root, SystemDrive: root.slice(0, 2) };
}

/** A runner's stdout/stderr as text, whether it returned a string, a Buffer or nothing. */
export function commandOutputText(value: string | Buffer | null): string {
  if (value === null) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : value;
}
