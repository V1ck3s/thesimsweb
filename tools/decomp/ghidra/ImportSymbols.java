// Ghidra pre-analysis script: apply a symbols.tsv (address, kind, name) to the
// current program, creating functions in their C++ namespaces, and optionally
// pin a register value (e.g. the PPC TOC in r2) over a range.
//
// Args: <symbols.tsv> [register value start end]
// @category TheSimsWeb
import ghidra.app.script.GhidraScript;
import ghidra.program.model.address.Address;
import ghidra.program.model.lang.Register;
import ghidra.program.model.listing.Function;
import ghidra.program.model.symbol.Namespace;
import ghidra.program.model.symbol.SourceType;
import ghidra.app.util.NamespaceUtils;
import java.io.BufferedReader;
import java.io.FileReader;
import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;

public class ImportSymbols extends GhidraScript {
    // Split "a<b::c>::d::e(args)" into ["a<b::c>", "d", "e"], dropping the argument list.
    static List<String> splitName(String full) {
        int depth = 0, paren = -1;
        for (int i = 0; i < full.length(); i++) {
            char c = full.charAt(i);
            if (c == '<') depth++;
            else if (c == '>') depth--;
            else if (c == '(' && depth == 0) { paren = i; break; }
        }
        String s = paren >= 0 ? full.substring(0, paren) : full;
        List<String> parts = new ArrayList<>();
        depth = 0;
        int start = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '<') depth++;
            else if (c == '>') depth--;
            else if (c == ':' && depth == 0 && i + 1 < s.length() && s.charAt(i + 1) == ':') {
                parts.add(s.substring(start, i));
                start = i + 2;
                i++;
            }
        }
        parts.add(s.substring(start));
        for (int i = 0; i < parts.size(); i++) parts.set(i, parts.get(i).trim().replace(' ', '_'));
        return parts;
    }

    @Override
    public void run() throws Exception {
        String[] args = getScriptArgs();
        if (args.length >= 4) {
            Register reg = currentProgram.getRegister(args[1]);
            BigInteger val = new BigInteger(args[2].replace("0x", ""), 16);
            Address start = toAddr(args[3].split("-")[0]);
            Address end = toAddr(args[3].split("-")[1]);
            currentProgram.getProgramContext().setValue(reg, start, end, val);
            println("pinned " + args[1] + "=" + args[2] + " over " + args[3]);
        }
        int funcs = 0, labels = 0;
        try (BufferedReader r = new BufferedReader(new FileReader(args[0]))) {
            String line;
            while ((line = r.readLine()) != null) {
                String[] f = line.split("\t", 3);
                if (f.length < 3) continue;
                Address a = toAddr(Long.parseLong(f[0], 16));
                List<String> parts = splitName(f[2]);
                String name = parts.remove(parts.size() - 1);
                if (name.isEmpty()) continue;
                Namespace ns = currentProgram.getGlobalNamespace();
                if (!parts.isEmpty()) {
                    try {
                        ns = NamespaceUtils.createNamespaceHierarchy(String.join("::", parts), null, currentProgram, SourceType.IMPORTED);
                    } catch (Exception e) {
                        ns = currentProgram.getGlobalNamespace();
                    }
                }
                try {
                    if (f[1].equals("func")) {
                        disassemble(a);
                        Function fn = getFunctionAt(a);
                        if (fn == null) fn = createFunction(a, null);
                        if (fn != null) {
                            fn.setName(name, SourceType.IMPORTED);
                            fn.setParentNamespace(ns);
                            fn.setComment(f[2]);
                            funcs++;
                        }
                    } else {
                        currentProgram.getSymbolTable().createLabel(a, name, ns, SourceType.IMPORTED);
                        labels++;
                    }
                } catch (Exception e) {
                    // Duplicate or invalid names are not fatal.
                }
            }
        }
        println("functions: " + funcs + ", labels: " + labels);
    }
}
