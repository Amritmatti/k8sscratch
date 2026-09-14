/* Employee Directory — talks to the same origin's /api/v1 endpoints.
   Plain ES modules-free script so it runs under a 'self'-only CSP with no
   build step and no bundler in the image. */

(function () {
  'use strict';

  var API = '/api/v1/employees';

  var form = document.getElementById('employee-form');
  var idField = document.getElementById('employee-id');
  var nameField = document.getElementById('name');
  var designationField = document.getElementById('designation');
  var dobField = document.getElementById('dob');
  var dojField = document.getElementById('doj');
  var submitBtn = document.getElementById('submit-btn');
  var cancelBtn = document.getElementById('cancel-btn');
  var formError = document.getElementById('form-error');
  var rows = document.getElementById('rows');
  var empty = document.getElementById('empty');
  var count = document.getElementById('count');
  var search = document.getElementById('search');
  var statusEl = document.getElementById('status');
  var metaEl = document.getElementById('meta');

  var searchTimer = null;

  // ---------------------------------------------------------------- helpers

  function showError(message) {
    formError.textContent = message;
    formError.hidden = !message;
  }

  /** Turn an API error body into one readable sentence. */
  function describeError(body, fallback) {
    if (!body || !body.error) return fallback;
    var msg = body.error.message || fallback;
    var details = body.error.details;
    if (Array.isArray(details) && details.length) {
      var parts = details.map(function (d) {
        if (typeof d === 'string') return d;
        var field = d.field || d.path || '';
        return field ? field + ' ' + (d.message || '') : d.message || '';
      });
      return msg + ' ' + parts.join('; ');
    }
    if (details && typeof details === 'object') {
      var keys = Object.keys(details);
      if (keys.length) {
        return msg + ' ' + keys.map(function (k) { return k + ' ' + details[k]; }).join('; ');
      }
    }
    return msg;
  }

  async function request(url, options) {
    var res = await fetch(url, options);
    if (res.status === 204) return null;
    var body = null;
    try { body = await res.json(); } catch (e) { /* empty or non-JSON body */ }
    if (!res.ok) {
      throw new Error(describeError(body, 'Request failed with status ' + res.status));
    }
    return body;
  }

  function setBusy(busy) {
    submitBtn.disabled = busy;
    submitBtn.textContent = busy
      ? 'Saving…'
      : (idField.value ? 'Save changes' : 'Add employee');
  }

  // ------------------------------------------------------------------ list

  function renderRows(list) {
    rows.replaceChildren();

    list.forEach(function (emp) {
      var tr = document.createElement('tr');
      tr.dataset.id = String(emp.id);

      tr.appendChild(cell(String(emp.id), 'id'));
      tr.appendChild(cell(emp.name));
      tr.appendChild(cell(emp.designation));
      tr.appendChild(cell(emp.dob, 'date'));
      tr.appendChild(cell(emp.doj, 'date'));

      var actions = document.createElement('td');

      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'link';
      edit.textContent = 'Edit';
      edit.addEventListener('click', function () { startEdit(emp); });

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'link danger';
      del.textContent = 'Delete';
      del.addEventListener('click', function () { remove(emp); });

      actions.appendChild(edit);
      actions.appendChild(del);
      tr.appendChild(actions);

      rows.appendChild(tr);
    });
  }

  function cell(text, className) {
    var td = document.createElement('td');
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  async function load() {
    var url = API + '?limit=200&sort=id&order=desc';
    var term = search.value.trim();
    if (term) url += '&search=' + encodeURIComponent(term);

    try {
      var body = await request(url);
      var list = (body && body.data) || [];
      renderRows(list);

      var total = body && body.pagination ? body.pagination.total : list.length;
      count.textContent = total ? '(' + total + ')' : '';
      empty.hidden = list.length > 0;
      empty.textContent = term
        ? 'No records match "' + term + '".'
        : 'No records yet. Add the first one above.';
    } catch (err) {
      empty.hidden = false;
      empty.textContent = 'Could not load records: ' + err.message;
      rows.replaceChildren();
      count.textContent = '';
    }
  }

  // ------------------------------------------------------------ create/edit

  function startEdit(emp) {
    idField.value = String(emp.id);
    nameField.value = emp.name;
    designationField.value = emp.designation;
    dobField.value = emp.dob;
    dojField.value = emp.doj;

    submitBtn.textContent = 'Save changes';
    cancelBtn.hidden = false;
    showError('');

    Array.prototype.forEach.call(rows.children, function (tr) {
      tr.classList.toggle('editing', tr.dataset.id === String(emp.id));
    });

    nameField.focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function resetForm() {
    form.reset();
    idField.value = '';
    submitBtn.textContent = 'Add employee';
    cancelBtn.hidden = true;
    showError('');
    Array.prototype.forEach.call(rows.children, function (tr) {
      tr.classList.remove('editing');
    });
  }

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    showError('');

    var payload = {
      name: nameField.value.trim(),
      designation: designationField.value.trim(),
      dob: dobField.value,
      doj: dojField.value,
    };

    if (!payload.name || !payload.designation || !payload.dob || !payload.doj) {
      showError('Fill in every field before saving.');
      return;
    }

    var editingId = idField.value;
    setBusy(true);
    try {
      await request(editingId ? API + '/' + encodeURIComponent(editingId) : API, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      resetForm();
      await load();
    } catch (err) {
      showError(err.message);
    } finally {
      setBusy(false);
    }
  });

  cancelBtn.addEventListener('click', resetForm);

  async function remove(emp) {
    if (!window.confirm('Delete ' + emp.name + '?')) return;
    try {
      await request(API + '/' + encodeURIComponent(emp.id), { method: 'DELETE' });
      if (idField.value === String(emp.id)) resetForm();
      await load();
    } catch (err) {
      showError(err.message);
    }
  }

  search.addEventListener('input', function () {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(load, 250);
  });

  // ---------------------------------------------------------------- status

  async function refreshStatus() {
    try {
      var res = await fetch('/readyz');
      var body = await res.json();
      var dbOk = body && body.checks && body.checks.database === 'ok';
      statusEl.dataset.state = res.ok && dbOk ? 'ok' : 'down';
      statusEl.textContent = res.ok && dbOk ? 'database connected' : 'database unavailable';
    } catch (e) {
      statusEl.dataset.state = 'down';
      statusEl.textContent = 'api unreachable';
    }
  }

  async function refreshMeta() {
    try {
      var info = await request('/api/v1');
      if (info && info.service) {
        metaEl.textContent = info.service + ' v' + info.version + ' · ' + info.commit;
      }
    } catch (e) { /* the footer is decoration; a failure here is not worth surfacing */ }
  }

  refreshStatus();
  refreshMeta();
  load();
  window.setInterval(refreshStatus, 30000);
})();
