"""The git identity a run's commit rules pass: -c user.name=... and -c user.email=...

Import with:
    sys.dont_write_bytecode = True
    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    import _identity

identity_pairs(commit_rules) returns the -c pairs for user.name and
user.email that the text passes, as ["user.name=VALUE", "user.email=VALUE"]:
keys in lower case, at most one pair per key (the last one given wins),
user.name first. A pair is written -c "NAME=VALUE", -c 'NAME=VALUE',
-c NAME="VALUE" (or 'VALUE') or -c NAME=VALUE; a bare word loses a trailing
. , ; : or ) (it may end a sentence or a parenthesis). A pair with an empty
value is not a pair. Text with no such pair, or a value that is not a
string, gives [].

setup prints the result as setup_result.git_identity; doctor's git_identity
check passes the pairs to git var.
"""

import re
import sys

sys.dont_write_bytecode = True

# -c NAME=VALUE: the pair quoted, NAME="VALUE", or a bare word.
_CONFIG_PAIR = re.compile(
    r"""(?:^|[\s`(])-c\s+(?:"([^"]*)"|'([^']*)'|([\w.]+=(?:"[^"]*"|'[^']*'))|([^\s`]+))""")
_IDENTITY_KEYS = ("user.name", "user.email")


def identity_pairs(commit_rules):
    """The -c user.name=... and -c user.email=... pairs commit_rules passes."""
    if not isinstance(commit_rules, str):
        return []
    values = {}
    for m in _CONFIG_PAIR.finditer(commit_rules):
        if m.group(4) is not None:
            # A bare word may end a sentence or a parenthesis.
            pair = m.group(4).rstrip(".,;:)")
        else:
            pair = next(g for g in m.groups()[:3] if g is not None)
        key, eq, value = pair.partition("=")
        key = key.lower()
        value = value.strip(" \"'")
        if eq and key in _IDENTITY_KEYS and value:
            values[key] = value
    return [key + "=" + values[key] for key in _IDENTITY_KEYS if key in values]
