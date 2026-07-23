import test from 'node:test';
import assert from 'node:assert/strict';
import {parseAttendanceOverlay} from '../dist/domain/attendance-overlay.js';

test('parses real MaliPang Buddhist Era white overlay',()=>{
  const parsed=parseAttendanceOverlay('23 Jul BE 2569 at 04:41:46\n+13.896795,+100.608147\n259/63 Phahon Yothin Road\nYingcharoen Market');
  assert.deepEqual(parsed,{photoDate:'2026-07-23',photoTime:'04:41:46',latitude:13.896795,longitude:100.608147});
});

test('parses English month-first, ISO, and numeric Buddhist dates',()=>{
  assert.deepEqual(parseAttendanceOverlay('Jul 20, 2026 5:33:23 PM 13.8968095N 100.6083093E'),{photoDate:'2026-07-20',photoTime:'17:33:23',latitude:13.8968095,longitude:100.6083093});
  assert.deepEqual(parseAttendanceOverlay('2026/07/21 17:16 +13.8968,+100.6083'),{photoDate:'2026-07-21',photoTime:'17:16:00',latitude:13.8968,longitude:100.6083});
  assert.deepEqual(parseAttendanceOverlay('23/07/2569 04:41:46 +13.896795,+100.608147'),{photoDate:'2026-07-23',photoTime:'04:41:46',latitude:13.896795,longitude:100.608147});
});
