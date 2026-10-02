"""Shared plan parsing for the parallel-lanes helpers (task-brief, derive-lanes).

A task heading is '#+ Task <ID>: <title>' outside fenced code. The id is the
token after 'Task' (no spaces, ':', '(', ')', '[' or ']'); qualifiers such as
'(join)' or '[T1, T5]' may sit between the id and the colon. A '#+ Task '
heading without that shape (e.g. '## Task overview') is not a task, but it
still ends the section of a task at the same level.

A task's section starts at its heading and ends before the next '#+ Task '
heading of the same or higher level, or before any heading of a strictly
higher level.
"""

import re
from collections import namedtuple

FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
HEADING = re.compile(r"^(#{1,6})\s")
TASK_BOUNDARY = re.compile(r"^(#{1,6})\s+Task\s")
TASK_HEADING = re.compile(
    r"^(#{1,6})\s+Task\s+([^\s:()\[\]]+)\s*((?:\([^()]*\)\s*|\[[^\]]*\]\s*)*):(.*)$"
)

# id, heading level, index of the heading line, index one past the section's
# last line, and the heading text after the colon.
TaskSection = namedtuple("TaskSection", "id level start end title")


def unfenced_mask(lines):
    """Return a list of booleans: True where a line is outside fenced code.

    Fence marker lines themselves are False.
    """
    mask = []
    fence = None
    for line in lines:
        m = FENCE.match(line)
        if m:
            marker = m.group(1)
            if fence is None:
                fence = marker
            elif marker[0] == fence[0] and len(marker) >= len(fence) and not line.strip()[len(marker):]:
                fence = None
            mask.append(False)
            continue
        mask.append(fence is None)
    return mask


def task_sections(lines, mask=None):
    """Return the TaskSection of every task heading, in plan order."""
    if mask is None:
        mask = unfenced_mask(lines)
    headings = []
    for i, line in enumerate(lines):
        if not mask[i]:
            continue
        h = HEADING.match(line)
        if h:
            headings.append((i, len(h.group(1)), bool(TASK_BOUNDARY.match(line)), TASK_HEADING.match(line)))
    sections = []
    for n, (start, level, _, task) in enumerate(headings):
        if task is None:
            continue
        end = len(lines)
        for i, lvl, boundary, _ in headings[n + 1:]:
            if lvl < level or (boundary and lvl == level):
                end = i
                break
        sections.append(TaskSection(task.group(2), level, start, end, task.group(4)))
    return sections
