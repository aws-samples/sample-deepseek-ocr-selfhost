FROM public.ecr.aws/lambda/python:3.11

COPY requirements.txt ${LAMBDA_TASK_ROOT}/
RUN pip install -r ${LAMBDA_TASK_ROOT}/requirements.txt

COPY lambda.py ${LAMBDA_TASK_ROOT}/

CMD ["lambda.handler"]
