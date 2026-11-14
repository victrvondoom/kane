import sys
from pt.python_version import require_supported
require_supported()
from pt.cli import main
sys.exit(main())
