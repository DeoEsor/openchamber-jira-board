import {
  mountBanner,
  mountButton,
  mountEmpty,
  mountSelect,
  mountTextField,
} from '@openchamber/sdk/ui';
import { hasUnknownOutcome } from '../shared/request-outcome.ts';
import type {
  JiraSourceInput,
  JiraSourceKind,
  PublicJiraSource,
} from '../shared/types.ts';

type Disposable = { dispose: () => void };

type SourceManagerOptions = {
  save: (input: JiraSourceInput, sourceId?: string) => Promise<PublicJiraSource>;
  remove: (sourceId: string) => Promise<void>;
  changed: () => void;
};

type Draft = {
  name: string;
  type: JiraSourceKind;
  url: string;
  email: string;
  token: string;
  projectKey: string;
  boardId: string;
};

const emptyDraft = (): Draft => ({
  name: '', type: 'cloud', url: '', email: '', token: '', projectKey: '', boardId: '',
});

export function createSourceManager(root: HTMLElement, options: SourceManagerOptions) {
  let sources: PublicJiraSource[] = [];
  let mode: 'list' | 'form' = 'list';
  let editingId: string | null = null;
  let draft = emptyDraft();
  let busy = false;
  let error: string | null = null;
  let confirmDeleteId: string | null = null;
  let controls: Disposable[] = [];
  let previouslyFocused: HTMLElement | null = null;

  const close = () => {
    if (busy) return;
    controls.forEach((control) => control.dispose());
    controls = [];
    root.replaceChildren();
    document.querySelector('.app')?.removeAttribute('inert');
    document.removeEventListener('keydown', onKeyDown);
    draft = emptyDraft();
    editingId = null;
    error = null;
    confirmDeleteId = null;
    previouslyFocused?.focus();
    previouslyFocused = null;
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close();
  };

  const button = (parent: HTMLElement, label: string, onClick: () => void, variant: 'default' | 'secondary' | 'outline' | 'ghost' | 'destructive' = 'outline') => {
    const mount = document.createElement('div');
    parent.append(mount);
    const control = mountButton(mount, { label, variant, size: 'sm', disabled: busy, onClick });
    controls.push(control);
    return control;
  };

  const renderHeader = (dialog: HTMLElement, title: string, description: string) => {
    const header = document.createElement('div');
    header.className = 'manager-header';
    const copy = document.createElement('div');
    const heading = document.createElement('h2');
    heading.id = 'source-manager-title';
    heading.textContent = title;
    const detail = document.createElement('p');
    detail.textContent = description;
    copy.append(heading, detail);
    const closeMount = document.createElement('div');
    header.append(copy, closeMount);
    controls.push(mountButton(closeMount, { label: '×', variant: 'ghost', size: 'sm', disabled: busy, onClick: close }));
    dialog.append(header);
  };

  const renderError = (dialog: HTMLElement) => {
    if (!error) return;
    const mount = document.createElement('div');
    mount.className = 'manager-error';
    dialog.append(mount);
    controls.push(mountBanner(mount, { tone: 'error', title: 'Source was not saved', body: error }));
  };

  const showList = () => {
    if (busy) return;
    mode = 'list';
    editingId = null;
    error = null;
    confirmDeleteId = null;
    draw();
  };

  const showForm = (source?: PublicJiraSource) => {
    if (busy) return;
    mode = 'form';
    editingId = source?.id ?? null;
    draft = source ? {
      name: source.name,
      type: source.kind,
      url: source.baseUrl,
      email: source.email ?? '',
      token: '',
      projectKey: source.defaultProjectKey ?? '',
      boardId: source.defaultBoardId === undefined ? '' : String(source.defaultBoardId),
    } : emptyDraft();
    error = null;
    draw();
  };

  const removeSource = async (sourceId: string) => {
    busy = true;
    error = null;
    draw();
    try {
      await options.remove(sourceId);
      busy = false;
      close();
      options.changed();
    } catch (caught) {
      busy = false;
      if (hasUnknownOutcome(caught)) {
        close();
        return;
      }
      error = caught instanceof Error ? caught.message : String(caught);
      confirmDeleteId = null;
      draw();
    }
  };

  const renderList = (dialog: HTMLElement) => {
    renderHeader(dialog, 'Jira sources', 'Connect Cloud and Data Center accounts without editing JSON.');
    renderError(dialog);
    const content = document.createElement('div');
    content.className = 'manager-content';
    dialog.append(content);

    if (!sources.length) {
      const emptyMount = document.createElement('div');
      content.append(emptyMount);
      controls.push(mountEmpty(emptyMount, {
        title: 'No Jira sources yet',
        body: 'Add your first source to choose a project and board.',
        action: { label: '+ Add source', onClick: () => showForm() },
      }));
    } else {
      const list = document.createElement('div');
      list.className = 'source-list';
      content.append(list);
      for (const source of sources) {
        const item = document.createElement('article');
        item.className = 'source-item';
        if (confirmDeleteId === source.id) {
          const copy = document.createElement('div');
          copy.className = 'source-confirm-copy';
          const title = document.createElement('strong');
          title.textContent = `Remove ${source.name}?`;
          const detail = document.createElement('span');
          detail.textContent = 'Only this connection is removed. Jira issues are not changed.';
          copy.append(title, detail);
          const actions = document.createElement('div');
          actions.className = 'source-actions';
          button(actions, 'Cancel', () => { confirmDeleteId = null; draw(); }, 'ghost');
          const remove = button(actions, 'Remove', () => void removeSource(source.id), 'destructive');
          remove.update({ loading: busy, disabled: busy });
          item.append(copy, actions);
        } else {
          const copy = document.createElement('div');
          copy.className = 'source-copy';
          const title = document.createElement('div');
          title.className = 'source-title';
          const name = document.createElement('strong');
          name.textContent = source.name;
          const kind = document.createElement('span');
          kind.className = 'source-kind';
          kind.textContent = source.kind === 'cloud' ? 'Cloud' : 'Data Center';
          title.append(name, kind);
          const url = document.createElement('span');
          url.className = 'source-url';
          url.textContent = source.baseUrl;
          copy.append(title, url);
          if (source.email) {
            const email = document.createElement('span');
            email.className = 'source-email';
            email.textContent = source.email;
            copy.append(email);
          }
          const actions = document.createElement('div');
          actions.className = 'source-actions';
          button(actions, 'Edit', () => showForm(source));
          button(actions, 'Remove', () => { confirmDeleteId = source.id; draw(); }, 'ghost');
          item.append(copy, actions);
        }
        list.append(item);
      }
    }

    const footer = document.createElement('div');
    footer.className = 'manager-footer';
    const add = button(footer, '+ Add source', () => showForm(), 'default');
    add.update({ disabled: busy || sources.length >= 16 });
    const spacer = document.createElement('div');
    spacer.className = 'manager-footer-spacer';
    footer.append(spacer);
    button(footer, 'Done', close, 'secondary');
    dialog.append(footer);
  };

  const renderForm = (dialog: HTMLElement) => {
    const editing = sources.find((source) => source.id === editingId);
    renderHeader(dialog, editing ? 'Edit Jira source' : 'Add Jira source', editing
      ? 'Update connection details or replace its credential.'
      : 'Enter the same details you would use to sign in to Jira.');
    renderError(dialog);
    const form = document.createElement('form');
    form.className = 'source-form';
    dialog.append(form);

    const field = (parent: HTMLElement, value: string, label: string, placeholder: string, onChange: (value: string) => void, password = false) => {
      const mount = document.createElement('div');
      parent.append(mount);
      const control = mountTextField(mount, { value, label, placeholder, password, disabled: busy, onChange });
      controls.push(control);
      return control;
    };

    field(form, draft.name, 'Name', 'Acme Cloud', (value) => { draft.name = value; });
    const credentialInstruction = () => `${draft.type === 'cloud'
      ? 'Create an API token in your Atlassian account security settings.'
      : 'Use a Jira Data Center personal access token.'}${editing
        ? ' Leave it blank only when the Jira URL and type stay unchanged.'
        : ''}`;
    const typeMount = document.createElement('div');
    form.append(typeMount);
    controls.push(mountSelect(typeMount, {
      label: 'Jira type',
      value: draft.type,
      options: [{ id: 'cloud', label: 'Jira Cloud' }, { id: 'datacenter', label: 'Jira Data Center' }],
      disabled: busy,
      onChange: (value) => {
        draft.type = value === 'datacenter' ? 'datacenter' : 'cloud';
        emailRow.hidden = draft.type !== 'cloud';
        emailControl.update({ disabled: busy || draft.type !== 'cloud' });
        credentialHelp.textContent = credentialInstruction();
      },
    }));
    field(form, draft.url, 'Jira URL', draft.type === 'cloud' ? 'https://your-team.atlassian.net' : 'https://jira.example.com', (value) => { draft.url = value; });
    const emailRow = document.createElement('div');
    emailRow.hidden = draft.type !== 'cloud';
    form.append(emailRow);
    const emailControl = field(emailRow, draft.email, 'Atlassian account email', 'you@example.com', (value) => { draft.email = value; });
    emailControl.update({ disabled: busy || draft.type !== 'cloud' });
    field(form, draft.token, editing ? 'New API token / PAT (optional)' : 'API token / PAT', editing ? 'Leave blank to keep the current credential' : 'Paste your token', (value) => { draft.token = value; }, true);
    const credentialHelp = document.createElement('p');
    credentialHelp.className = 'manager-helper';
    credentialHelp.textContent = credentialInstruction();
    form.append(credentialHelp);

    const optional = document.createElement('details');
    optional.className = 'source-optional';
    const summary = document.createElement('summary');
    summary.textContent = 'Default selection (optional)';
    optional.append(summary);
    const optionalFields = document.createElement('div');
    optionalFields.className = 'source-optional-fields';
    optional.append(optionalFields);
    field(optionalFields, draft.projectKey, 'Project key', 'APP', (value) => { draft.projectKey = value; });
    field(optionalFields, draft.boardId, 'Board ID', '42', (value) => { draft.boardId = value; });
    form.append(optional);

    const footer = document.createElement('div');
    footer.className = 'manager-footer';
    button(footer, 'Back', showList, 'ghost');
    const spacer = document.createElement('div');
    spacer.className = 'manager-footer-spacer';
    footer.append(spacer);
    const saveMount = document.createElement('div');
    footer.append(saveMount);
    const saveButton = mountButton(saveMount, { label: editing ? 'Save changes' : 'Add source', variant: 'default', size: 'sm', loading: busy, disabled: busy, onClick: () => void submit() });
    controls.push(saveButton);
    form.append(footer);

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void submit();
    });
  };

  const submit = async () => {
    if (busy) return;
    if (!draft.name.trim() || !draft.url.trim() || (draft.type === 'cloud' && !draft.email.trim()) || (!editingId && !draft.token)) {
      error = draft.type === 'cloud'
        ? 'Enter a name, Jira URL, account email, and API token.'
        : 'Enter a name, Jira URL, and personal access token.';
      draw();
      return;
    }
    busy = true;
    error = null;
    draw();
    const input: JiraSourceInput = {
      name: draft.name.trim(),
      type: draft.type,
      url: draft.url.trim(),
      ...(draft.type === 'cloud' ? { email: draft.email.trim() } : {}),
      ...(draft.token ? { token: draft.token } : {}),
      ...(draft.projectKey.trim() ? { projectKey: draft.projectKey.trim() } : {}),
      ...(draft.boardId.trim() ? { boardId: draft.boardId.trim() } : {}),
    };
    try {
      await options.save(input, editingId ?? undefined);
      busy = false;
      close();
      options.changed();
    } catch (caught) {
      busy = false;
      if (hasUnknownOutcome(caught)) {
        close();
        return;
      }
      error = caught instanceof Error ? caught.message : String(caught);
      draw();
    }
  };

  function draw() {
    controls.forEach((control) => control.dispose());
    controls = [];
    root.replaceChildren();
    const backdrop = document.createElement('div');
    backdrop.className = 'manager-backdrop';
    backdrop.addEventListener('click', (event) => { if (event.target === backdrop) close(); });
    const dialog = document.createElement('section');
    dialog.className = 'manager-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'source-manager-title');
    backdrop.append(dialog);
    root.append(backdrop);
    if (mode === 'form') renderForm(dialog);
    else renderList(dialog);
    queueMicrotask(() => dialog.querySelector<HTMLElement>('input, button')?.focus());
  }

  return {
    open() {
      if (root.childElementCount) return;
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.querySelector('.app')?.setAttribute('inert', '');
      document.addEventListener('keydown', onKeyDown);
      mode = 'list';
      busy = false;
      error = null;
      confirmDeleteId = null;
      draw();
    },
    openAdd() {
      if (root.childElementCount) return;
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      document.querySelector('.app')?.setAttribute('inert', '');
      document.addEventListener('keydown', onKeyDown);
      showForm();
    },
    updateSources(next: PublicJiraSource[]) {
      sources = next;
      if (root.childElementCount && mode === 'list') draw();
    },
  };
}
