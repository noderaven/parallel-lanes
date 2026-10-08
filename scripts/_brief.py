"""Task briefs, shared by task-brief (writes them) and ledger (hashes them).

A brief is a task's own section of the plan (_plan.task_sections) followed by
the Produces blocks of the tasks it consumes. Errors raise BriefError with
the exit code task-brief uses.
"""

import hashlib
import re

import _plan

# Task ids that are safe as file names: no '/', no leading '.' or '-'. The
# same pattern as taskIdPattern in src/validate.js.
TASK_ID = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9._-]*$")

# A fence marker at any indent (a fence inside a nested bullet is indented).
FENCE_ANY = re.compile(r"^\s*(`{3,}|~{3,})")

_ID = re.compile(r"\w+(?:[.-]\w+)*")
_TASK_WORD = re.compile(r"\bTasks?\s+")
_SEPARATOR = re.compile(r"\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or)\s+")
# Words that make a number after a list separator a quantity, not a task:
# 'Task 4 and 3 mi a week' names Task 4 only.
_UNIT = re.compile(r"(?:%|\s+(?:mi|km|m|cm|mm|ms|s|sec|min|h|hr|hrs|kb|mb|gb|px|pt|em|x)\b)")


class BriefError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def is_safe_id(task_id):
    return bool(TASK_ID.fullmatch(task_id))


def _fence_closes(line, marker):
    m = FENCE_ANY.match(line)
    return bool(m) and m.group(1)[0] == marker[0] and len(m.group(1)) >= len(marker) \
        and not line.strip()[len(m.group(1)):]


def bullet_span(lines, mask, label):
    """(start, end) of the first '- <label>:' bullet outside fenced code and
    its continuation, trailing blank lines excluded; None if absent.

    The continuation is every line indented deeper than the bullet. A fence
    opened inside the block, at any indent, or right after the bullet line
    (even at the bullet's indent) runs to its closing fence.
    """
    bullet = re.compile(rf"^(\s*)- {re.escape(label)}:")
    for i, line in enumerate(lines):
        m = bullet.match(line) if mask[i] else None
        if not m:
            continue
        depth = len(m.group(1))
        end = i + 1
        fence = None
        bare = True  # no content line since the bullet line
        while end < len(lines):
            line = lines[end]
            if fence is not None:
                if _fence_closes(line, fence):
                    fence = None
            elif not line.strip():
                pass
            else:
                fm = FENCE_ANY.match(line)
                deeper = len(line) - len(line.lstrip()) > depth
                if deeper or (fm and bare):
                    if fm:
                        fence = fm.group(1)
                else:
                    break
            if line.strip():
                bare = False
            end += 1
        while not lines[end - 1].strip():
            end -= 1
        return i, end
    return None


def bullet_block(lines, mask, label):
    span = bullet_span(lines, mask, label)
    return lines[span[0]:span[1]] if span else None


def has_letter_and_digit(task_id):
    return any(c.isalpha() for c in task_id) and any(c.isdigit() for c in task_id)


def _listed_ids(text):
    """Ids named after 'Task' or 'Tasks', including lists ('Tasks 3, 6 and 9',
    'Tasks 2 and 3 outputs'). The first id after the word always counts; an id
    after a separator counts unless a unit follows it ('3 mi', '30%')."""
    found = []
    for word in _TASK_WORD.finditer(text):
        pos = word.end()
        m = _ID.match(text, pos)
        if not m:
            continue
        found.append(m.group(0))
        pos = m.end()
        while True:
            if text.startswith("'s", pos):
                pos += 2
            sep = _SEPARATOR.match(text, pos)
            if not sep or sep.end() == pos:
                break
            item = _ID.match(text, sep.end())
            if not item:
                break
            if _UNIT.match(text, item.end()):
                break
            found.append(item.group(0))
            pos = item.end()
    return found


def consumed_ids(block_text, known_ids, self_id):
    """The ids in known_ids that block_text names, without self_id.

    An id with both a letter and a digit (G1) matches as a whole word ('G1.5'
    does not name G1); any other id (4, 1.5) only after 'Task' or 'Tasks'.
    """
    found = set()
    for task_id in known_ids:
        if has_letter_and_digit(task_id) and re.search(
            rf"(?<![\w.-]){re.escape(task_id)}(?![\w-]|\.\w)", block_text
        ):
            found.add(task_id)
    for token in _listed_ids(block_text):
        if token in known_ids and not has_letter_and_digit(token):
            found.add(token)
    found.discard(self_id)
    return found


def own_section(lines, sections, task_id):
    """(TaskSection, section lines without trailing blank lines)."""
    starts = [s for s in sections if s.id == task_id]
    if not starts:
        raise BriefError(3, f"no heading for task {task_id!r}")
    if len(starts) > 1:
        raise BriefError(3, f"task {task_id!r} has {len(starts)} headings; refusing to guess")
    own = starts[0]
    section = lines[own.start:own.end]
    while section and not section[-1].strip():
        section.pop()
    if not any(line.strip() for line in section[1:]):
        raise BriefError(3, f"task {task_id!r} section is empty")
    return own, section


def section_text(text, task_id):
    """The task's own section, as the brief starts with it."""
    lines = text.splitlines()
    _, section = own_section(lines, _plan.task_sections(lines), task_id)
    return "\n".join(section) + "\n"


def section_sha256(text, task_id):
    """sha256 of the task's own section: what a review approved against."""
    return hashlib.sha256(section_text(text, task_id).encode("utf-8")).hexdigest()


def build(text, task_id, also):
    lines = text.splitlines()
    mask = _plan.unfenced_mask(lines)
    sections = _plan.task_sections(lines, mask)
    own, section = own_section(lines, sections, task_id)

    # A referenced id with two headings uses the first.
    first = {}
    for s in sections:
        first.setdefault(s.id, s)

    referenced = set()
    own_mask = mask[own.start:own.end]
    span = bullet_span(section, own_mask, "Consumes")
    if span:
        # Only text outside fenced code inside the bullet names tasks.
        named = [section[i] for i in range(*span) if own_mask[i]]
        referenced = consumed_ids("\n".join(named), set(first), task_id)
    missing = []
    for extra in also:
        if extra == task_id:
            continue
        if extra in first:
            referenced.add(extra)
        elif extra not in missing:
            missing.append(extra)

    parts = ["\n".join(section)]
    for s in sorted((first[i] for i in referenced), key=lambda s: s.start):
        heading = f"## Produces of Task {s.id}: {s.title.strip()} (consumed by this task)"
        block = bullet_block(lines[s.start:s.end], mask[s.start:s.end], "Produces")
        body = "\n".join(block) if block else f"Task {s.id} has no Produces block in the plan."
        parts.append(f"{heading}\n\n{body}")
    parts.extend(f"Task {m} has no heading in the plan." for m in missing)
    return "\n\n".join(parts) + "\n"
