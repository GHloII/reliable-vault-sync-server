const MAX_DIFF_CELLS = 4_000_000;

interface Edit {
  start: number;
  end: number;
  replacement: string[];
}

function splitLines(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)?.filter((line) => line.length > 0) ?? [];
}

function sameLines(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function diffEdits(base: string[], variant: string[]): Edit[] | null {
  let prefix = 0;
  while (prefix < base.length && prefix < variant.length && base[prefix] === variant[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < base.length - prefix
    && suffix < variant.length - prefix
    && base[base.length - suffix - 1] === variant[variant.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const baseMiddle = base.slice(prefix, base.length - suffix);
  const variantMiddle = variant.slice(prefix, variant.length - suffix);
  if (baseMiddle.length === 0 || variantMiddle.length === 0) {
    return baseMiddle.length === 0 && variantMiddle.length === 0
      ? []
      : [{ start: prefix, end: prefix + baseMiddle.length, replacement: variantMiddle }];
  }
  if (baseMiddle.length * variantMiddle.length > MAX_DIFF_CELLS) {
    return null;
  }

  const width = variantMiddle.length + 1;
  const lcs = new Uint32Array((baseMiddle.length + 1) * width);
  for (let baseIndex = baseMiddle.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let variantIndex = variantMiddle.length - 1; variantIndex >= 0; variantIndex -= 1) {
      const index = baseIndex * width + variantIndex;
      lcs[index] = baseMiddle[baseIndex] === variantMiddle[variantIndex]
        ? lcs[(baseIndex + 1) * width + variantIndex + 1]! + 1
        : Math.max(lcs[(baseIndex + 1) * width + variantIndex]!, lcs[index + 1]!);
    }
  }

  const edits: Edit[] = [];
  let baseIndex = 0;
  let variantIndex = 0;
  let pending: Edit | null = null;
  const flush = () => {
    if (pending !== null) {
      edits.push(pending);
      pending = null;
    }
  };

  while (baseIndex < baseMiddle.length || variantIndex < variantMiddle.length) {
    if (
      baseIndex < baseMiddle.length
      && variantIndex < variantMiddle.length
      && baseMiddle[baseIndex] === variantMiddle[variantIndex]
    ) {
      flush();
      baseIndex += 1;
      variantIndex += 1;
      continue;
    }

    pending ??= { start: prefix + baseIndex, end: prefix + baseIndex, replacement: [] };
    const insert = variantIndex < variantMiddle.length && (
      baseIndex === baseMiddle.length
      || lcs[baseIndex * width + variantIndex + 1]! >= lcs[(baseIndex + 1) * width + variantIndex]!
    );
    if (insert) {
      pending.replacement.push(variantMiddle[variantIndex]!);
      variantIndex += 1;
    } else {
      baseIndex += 1;
      pending.end = prefix + baseIndex;
    }
  }
  flush();
  return edits;
}

function editsOverlap(left: Edit, right: Edit): boolean {
  const leftInsertion = left.start === left.end;
  const rightInsertion = right.start === right.end;
  if (leftInsertion && rightInsertion) {
    return left.start === right.start;
  }
  if (leftInsertion) {
    return right.start < left.start && left.start < right.end;
  }
  if (rightInsertion) {
    return left.start < right.start && right.start < left.end;
  }
  return left.start < right.end && right.start < left.end;
}

function sameEdit(left: Edit, right: Edit): boolean {
  return left.start === right.start
    && left.end === right.end
    && sameLines(left.replacement, right.replacement);
}

/**
 * Merges independent line edits from LOCAL and REMOTE against BASE.
 * Returns null when both sides alter the same base lines or insert different
 * content at the same position, leaving the caller to preserve a conflict.
 */
export function mergeIndependentTextChanges(baseText: string, localText: string, remoteText: string): string | null {
  if (localText === remoteText) {
    return localText;
  }
  if (localText === baseText) {
    return remoteText;
  }
  if (remoteText === baseText) {
    return localText;
  }

  const base = splitLines(baseText);
  const localEdits = diffEdits(base, splitLines(localText));
  const remoteEdits = diffEdits(base, splitLines(remoteText));
  if (localEdits === null || remoteEdits === null) {
    return null;
  }

  const duplicates = new Set<Edit>();
  for (const local of localEdits) {
    for (const remote of remoteEdits) {
      if (sameEdit(local, remote)) {
        duplicates.add(remote);
      } else if (editsOverlap(local, remote)) {
        return null;
      }
    }
  }

  const edits = [...localEdits, ...remoteEdits.filter((edit) => !duplicates.has(edit))].sort((left, right) => {
    if (left.start !== right.start) {
      return left.start - right.start;
    }
    return left.end - right.end;
  });
  const merged: string[] = [];
  let cursor = 0;
  for (const edit of edits) {
    merged.push(...base.slice(cursor, edit.start), ...edit.replacement);
    cursor = Math.max(cursor, edit.end);
  }
  merged.push(...base.slice(cursor));
  return merged.join("");
}
