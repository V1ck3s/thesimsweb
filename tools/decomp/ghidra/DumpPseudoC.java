// Ghidra post-analysis script: decompile every function and write pseudo-C,
// one file per top-level namespace (C++ class), into the given directory.
//
// Args: <outdir> [timeoutSeconds]
// @category TheSimsWeb
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Namespace;
import java.io.File;
import java.io.FileWriter;
import java.util.Map;
import java.util.TreeMap;

public class DumpPseudoC extends GhidraScript {
    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        File out = new File(args[0]);
        out.mkdirs();
        int timeout = args.length > 1 ? Integer.parseInt(args[1]) : 60;
        DecompInterface d = new DecompInterface();
        d.setOptions(new DecompileOptions());
        d.openProgram(currentProgram);
        Map<String, StringBuilder> files = new TreeMap<>();
        int n = 0, failed = 0;
        for (Function f : currentProgram.getFunctionManager().getFunctions(true)) {
            if (monitor.isCancelled()) break;
            Namespace ns = f.getParentNamespace();
            while (ns.getParentNamespace() != null && !ns.getParentNamespace().isGlobal()) ns = ns.getParentNamespace();
            String key = ns.isGlobal() ? "_global" : ns.getName();
            key = key.replaceAll("[^A-Za-z0-9_.-]", "_");
            if (key.length() > 80) key = key.substring(0, 80);
            StringBuilder sb = files.computeIfAbsent(key, k -> new StringBuilder());
            sb.append("\n// ").append(f.getEntryPoint()).append("  ")
              .append(f.getComment() != null ? f.getComment() : f.getName(true)).append("\n");
            DecompileResults res = d.decompileFunction(f, timeout, monitor);
            if (res != null && res.decompileCompleted()) {
                sb.append(res.getDecompiledFunction().getC());
            } else {
                sb.append("// decompilation failed\n");
                failed++;
            }
            if (++n % 500 == 0) println("decompiled " + n);
        }
        for (Map.Entry<String, StringBuilder> e : files.entrySet()) {
            try (FileWriter w = new FileWriter(new File(out, e.getKey() + ".c"))) {
                w.write(e.getValue().toString());
            }
        }
        println("done: " + n + " functions, " + failed + " failed, " + files.size() + " files");
    }
}
