# This feature to implement the simple task management for this web site

## Feature concept
- A task always belong to a project
- Tasks are actions that need to be done for that project, and maybe related to a specific environment
- In point of view of environment, at a specific time, if all the tasks on this environment is done, this environment is free.
- In point of view of project booking, a task if stick to an environment, this duration will make the booking for that its project to this environment. It means, there are two way to book an environment: explicit booking (as current) or create a task related to a environment. Application must have the smart way to calculate the duration of booking based on this. 
- The booking is longer has higher priority, it means if user manually books the environment is 3 months, but the duration of all tasks are just 2 months, application still keep 3 months. if manual booking is 2 months and duration of all tasks are 3 months, application will automatically adjust to 3 months
- Because this is task management so allow user to arrange the tasks, set dependencies, duration, calculate duration of all project (booking), show the network diagram, identify critical path
- Task can be not related to any environment, in this case, it still be managed in task management feature, but it duration is not used to calculate the booking duration

## Business requirements

### Task management feature
- Allow user add tasks to project, task can be related to a environment or not
- Allow user view the task list
- Allow user set the task durationm dependencies
- Allow user edit delete a task, calculate the risk when delete a task and show the waring to user. Recalculate all related information when edit or delete a task

### Task visualization
- Generate and show to user the project management diagrams network diagram, critical path,...
- If user want to show the environment on network diagram, show it

## Enrich requirement
- This feature add the simple project management feature to the web, focus on task. So based on the best practices, brain storm to enrich requirement

## UI/UX design
- Use frontend design skill to design this feature
## Decisions (answered 2026-09-27)

- A manual booking longer than its tasks stands, even once every task is done; the board then
  offers **Release**, which trims it to the last task's finish.
- Task dates are scheduled from duration, predecessors and an optional "start no earlier than"
  (critical path method), not typed.
- Tasks on the same environment merge into one booking while the gap between them is at most
  2 working days; a longer gap frees the environment in between.
- Dependencies stay within one project.

Design and rules: `DESIGN.md` §16.
