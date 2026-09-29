-- Subtasks are one level deep: a task may reference a parent task owned by the same user.
-- The composite foreign key keeps a subtask and its parent in the same account, and the
-- index supports listing a parent's children.
ALTER TABLE tasks ADD COLUMN parent_id uuid;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_parent_fk FOREIGN KEY (parent_id, user_id) REFERENCES entities (id, user_id) ON DELETE CASCADE;
CREATE INDEX tasks_user_parent ON tasks (user_id, parent_id) WHERE parent_id IS NOT NULL;
